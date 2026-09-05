import { DurableObject } from "cloudflare:workers";

import { getCrawlerSettings, getShopRequestDelayMs, shopEnvVarName } from "../config.js";
import {
  hasCrawlFetchDetailPage,
  recordCrawlFetchDetailPage,
} from "../db/crawl-fetch-detail-repository.js";
import { getCrawlFetchPage, getCrawlFetchSession } from "../db/crawl-fetch-session-repository.js";
import type { StoredCollectionProgress } from "../db/crawl-fetch-progress.js";
import type { CollectionProgressState } from "./collection-progress.js";
import { syncProductSearchEntities } from "../db/product-search-entity-repository.js";
import {
  accountReads,
  dbUsageMetrics,
  sumDbUsageMetrics,
  type DbUsageMetrics,
} from "../db/read-accounting.js";
import { crawlDispatchToken } from "../db/shop-state-repository.js";
import type { QueryableDatabase } from "../db/types.js";
import { planStagedCategoryDetailInputs } from "./category-enrichment-pacing.js";
import {
  advanceDetailPlanCursor,
  detailEnrichmentProgress,
  nextUncommittedDetailTargetWithInput,
  storedDetailDecisionAt,
  type DetailEnrichmentPlanContext,
  type DetailEnrichmentPlanStorage,
} from "./detail-enrichment-plan.js";
import {
  fetchPreparedDirectHtmlPage,
  prepareDirectFetchPermit,
  type DirectFetchPermit,
} from "./direct-pacing.js";
import { prepareShopInventoryRecheck, recheckShopInventory } from "./inventory-recheck.js";
import {
  CRAWL_SCHEDULER_COMMAND_VERSION,
  CRAWL_SCHEDULER_START_PATH,
  isCrawlDoEligible,
  type CrawlSchedulerStartCommand,
} from "./orchestration.js";
import {
  fetchPreparedRelayHtmlPage,
  fetchPreparedRelayPage,
  prepareRelayFetchPermit,
  type RelayFetchPermit,
} from "./relay.js";
import {
  executeResumableCrawlStep,
  type ResumableCrawlQueueMessage,
} from "./resumable-crawl-executor.js";
import { getShopPlugin } from "./shops/index.js";
import { relayConfiguration } from "./transport.js";
import type { ShopPlugin } from "./types.js";

// Durable Object storage namespaces must stay stable across Worker deployments so an in-flight
// execution created by an older isolate remains visible to the new runtime and its scheduled Alarm.
const EXECUTION_STORAGE_KEY = "phase2_crawl_execution";
const MIN_ALARM_DELAY_MS = 1;

interface StoredExecution {
  message: ResumableCrawlQueueMessage;
  acceptedAt: string;
  nextOriginNotBeforeMs: number;
  /** Direct seller permit for either a listing page or a staged detail page. */
  permit?: DirectFetchPermit;
  /** The permit was durably consumed before seller I/O; a retry must prepare a fresh permit. */
  directFetchAttempted?: boolean;
  /** Relay PREPARE permit for listing, category-detail or inventory HTTP. */
  relayPermit?: RelayFetchPermit;
  /** Detail URL bound to permit/relayPermit while category enrichment waits on its Alarm. */
  detailTargetUrl?: string;
  /** Durable hand-off: finalization owns no seller HTTP; the DO runs inventory after D1 commit. */
  inventoryRecheckPending?: boolean;
  /** Aggregate D1 usage for the paced detail phase; emitted once when the plan is exhausted. */
  detailDbUsage?: StoredDetailDbUsage;
  /** Durable marker preventing terminal-check reads from producing duplicate completion metrics. */
  detailDbUsageLogged?: boolean;
  /** Missing on pre-deployment executions, which keep their D1 progress until completion. */
  collectionProgress?: StoredCollectionProgress | null;
}

interface StoredDetailDbUsage {
  fence: DbUsageMetrics;
  commit: DbUsageMetrics;
}

function accumulatedDetailDbUsage(
  stored: StoredDetailDbUsage | undefined,
  fence: DbUsageMetrics,
  commit: DbUsageMetrics,
): StoredDetailDbUsage {
  return {
    fence: sumDbUsageMetrics(stored?.fence ?? sumDbUsageMetrics(), fence),
    commit: sumDbUsageMetrics(stored?.commit ?? sumDbUsageMetrics(), commit),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCrawlSchedulerStartCommand(value: unknown): CrawlSchedulerStartCommand | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== CRAWL_SCHEDULER_COMMAND_VERSION || value.type !== "start_crawl") {
    return null;
  }
  if (!isRecord(value.message)) return null;
  const message = value.message;
  if (
    typeof message.shopKey !== "string" ||
    !message.shopKey ||
    typeof message.requestedAt !== "string" ||
    !message.requestedAt ||
    typeof message.force !== "boolean"
  ) {
    return null;
  }
  return {
    schemaVersion: CRAWL_SCHEDULER_COMMAND_VERSION,
    type: "start_crawl",
    message: {
      shopKey: message.shopKey,
      requestedAt: message.requestedAt,
      force: message.force,
      ...(typeof message.jobId === "string" ? { jobId: message.jobId } : {}),
      ...(typeof message.batchRunId === "string" ? { batchRunId: message.batchRunId } : {}),
    },
  };
}

function executionIdentity(message: ResumableCrawlQueueMessage): string {
  return message.jobId || crawlDispatchToken(message.shopKey, message.requestedAt);
}

function alarmAt(timestampMs: number): number {
  return Math.max(Date.now() + MIN_ALARM_DELAY_MS, timestampMs);
}

function isRelayPlugin(plugin: ShopPlugin): boolean {
  return plugin.capabilities.transport?.kind === "relay";
}

function withoutInlineInventoryRecheck(env: Env, plugin: ShopPlugin): Env {
  if (!plugin.capabilities.inventoryRecheck) return env;
  const setting = shopEnvVarName(plugin.definition, "INVENTORY_RECHECK_ENABLED");
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === setting) return "false";
      return Reflect.get(target, property, receiver);
    },
  });
}

/**
 * Per-shop crawl control plane. Every Alarm performs one bounded crawl transition or one prepared
 * seller request. Seller waits are represented by Alarm timestamps, never sleep/setTimeout.
 */
export class CrawlScheduler extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    if (url.pathname === CRAWL_SCHEDULER_START_PATH) return this.startCrawl(request);
    return new Response("not found", { status: 404 });
  }

  private async startCrawl(request: Request): Promise<Response> {
    let command: CrawlSchedulerStartCommand | null = null;
    try {
      command = parseCrawlSchedulerStartCommand(await request.json());
    } catch {
      // handled below
    }
    if (!command) return new Response("invalid command", { status: 400 });
    const message = command.message;
    if (!isCrawlDoEligible(message.shopKey)) {
      return new Response("shop is not eligible for DO execution", { status: 400 });
    }

    const existing = await this.ctx.storage.get<StoredExecution>(EXECUTION_STORAGE_KEY);
    if (existing) {
      if (
        existing.message.shopKey === message.shopKey &&
        executionIdentity(existing.message) === executionIdentity(message)
      ) {
        await this.ctx.storage.setAlarm(alarmAt(Date.now()));
        return new Response(null, { status: 202 });
      }
      console.warn(
        JSON.stringify({
          event: "crawl_do_busy",
          shopKey: message.shopKey,
          requestedAt: message.requestedAt,
          jobId: executionIdentity(message),
          activeJobId: executionIdentity(existing.message),
        }),
      );
      return new Response("scheduler busy", { status: 409 });
    }

    const acceptedAt = new Date().toISOString();
    await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
      message,
      acceptedAt,
      nextOriginNotBeforeMs: 0,
      collectionProgress: null,
    });
    await this.ctx.storage.setAlarm(alarmAt(Date.now()));
    console.log(
      JSON.stringify({
        event: "crawl_do_accepted",
        shopKey: message.shopKey,
        requestedAt: message.requestedAt,
        jobId: executionIdentity(message),
        batchRunId: message.batchRunId || null,
        acceptedAt,
      }),
    );
    return new Response(null, { status: 202 });
  }

  async alarm(): Promise<void> {
    const execution = await this.ctx.storage.get<StoredExecution>(EXECUTION_STORAGE_KEY);
    if (!execution) return;
    await this.runExecutionStep(execution);
  }

  private async runInventoryRecheckStep(
    execution: StoredExecution,
    plugin: ShopPlugin,
  ): Promise<void> {
    const startedAtMs = Date.now();
    if (!isRelayPlugin(plugin) || !plugin.capabilities.inventoryRecheck) {
      await this.ctx.storage.delete(EXECUTION_STORAGE_KEY);
      return;
    }

    let relayPermit = execution.relayPermit;
    if (!relayPermit) {
      const preparation = await prepareShopInventoryRecheck(this.env, plugin);
      if (preparation.status !== "ready") {
        await this.ctx.storage.delete(EXECUTION_STORAGE_KEY);
        console.log(
          JSON.stringify({
            event: "crawl_do_inventory_recheck_skipped",
            shopKey: plugin.key,
            runId: execution.message.collectionRunId || null,
            reason: preparation.reason,
            activeMs: Date.now() - startedAtMs,
          }),
        );
        return;
      }

      try {
        relayPermit = await prepareRelayFetchPermit(
          relayConfiguration(this.env),
          preparation.targetUrl,
          {
            userAgent: preparation.userAgent,
            requestDelayMs: preparation.requestDelayMs,
          },
        );
      } catch (error) {
        await this.ctx.storage.delete(EXECUTION_STORAGE_KEY);
        console.warn(
          JSON.stringify({
            event: "crawl_do_inventory_recheck_deferred",
            shopKey: plugin.key,
            runId: execution.message.collectionRunId || null,
            message: error instanceof Error ? error.message : String(error),
            activeMs: Date.now() - startedAtMs,
          }),
        );
        return;
      }

      await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
        ...execution,
        relayPermit,
      });
      await this.ctx.storage.setAlarm(alarmAt(relayPermit.notBeforeMs));
      console.log(
        JSON.stringify({
          event: "crawl_do_inventory_recheck_prepared",
          shopKey: plugin.key,
          runId: execution.message.collectionRunId || null,
          targetUrl: relayPermit.targetUrl,
          effectiveDelayMs: relayPermit.effectiveDelayMs,
          notBeforeMs: relayPermit.notBeforeMs,
          activeMs: Date.now() - startedAtMs,
        }),
      );
      return;
    }

    if (Date.now() < relayPermit.notBeforeMs) {
      await this.ctx.storage.setAlarm(alarmAt(relayPermit.notBeforeMs));
      return;
    }
    if (Date.now() >= relayPermit.expiresAtMs) {
      await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
        ...execution,
        relayPermit: undefined,
      });
      await this.ctx.storage.setAlarm(alarmAt(Date.now()));
      return;
    }

    const prepared = relayPermit;
    const result = await recheckShopInventory(this.env, plugin, {
      fetchPage: (url, options) =>
        fetchPreparedRelayPage(relayConfiguration(this.env), prepared, url, options),
    });
    if (result.status === "checked" && result.sourceId) {
      await syncProductSearchEntities(this.env.DB, plugin.key, [result.sourceId]);
    }
    await this.ctx.storage.delete(EXECUTION_STORAGE_KEY);
    console.log(
      JSON.stringify({
        event: "crawl_do_inventory_recheck_completed",
        shopKey: plugin.key,
        runId: execution.message.collectionRunId || null,
        status: result.status,
        reason: "reason" in result ? result.reason : null,
        outcome: "outcome" in result ? result.outcome : null,
        productId: "productId" in result ? result.productId || null : null,
        activeMs: Date.now() - startedAtMs,
      }),
    );
  }

  /**
   * The instant this run's detail enrichment was planned, if it has been planned.
   *
   * Finalization evaluates the same time-dependent eligibility policy the plan did, so it is given
   * the plan's instant rather than its own clock. Absent when the run has no plan -- either the shop
   * has no detail evidence or the phase was never reached -- and finalization then behaves as it did
   * before, on the current time.
   */
  private async detailDecisionAt(runId: string | undefined): Promise<string | undefined> {
    if (!runId) return undefined;
    return storedDetailDecisionAt(this.detailPlanStorage(), runId);
  }

  /** The Durable Object's own storage, as the narrow surface the plan policy is written against. */
  private detailPlanStorage(): DetailEnrichmentPlanStorage {
    return {
      get: (key) => this.ctx.storage.get(key),
      put: (key, value) => this.ctx.storage.put(key, value),
      delete: async (key) => {
        await this.ctx.storage.delete(key);
      },
    };
  }

  /** Binds the plan policy to this Durable Object's storage, planner, fence and log vocabulary. */
  private detailPlanContext(
    plugin: ShopPlugin,
    fenceDb: QueryableDatabase = this.env.DB,
  ): DetailEnrichmentPlanContext {
    return {
      storage: this.detailPlanStorage(),
      planTargets: (runId, decidedAt) =>
        planStagedCategoryDetailInputs(this.env, plugin, runId, decidedAt),
      isCommitted: (runId, targetUrl) => hasCrawlFetchDetailPage(fenceDb, runId, targetUrl),
      log: (event) => {
        if (event.kind === "plan_created") {
          console.log(
            JSON.stringify({
              event: "crawl_do_detail_plan_created",
              shopKey: plugin.key,
              runId: event.runId,
              targetCount: event.targetCount,
              chunkCount: event.chunkCount,
              source: event.source,
            }),
          );
          return;
        }
        console.log(
          JSON.stringify({
            event: "crawl_do_detail_target_already_committed",
            shopKey: plugin.key,
            runId: event.runId,
            skipped: event.skipped,
            cursor: event.cursor,
            targetCount: event.targetCount,
          }),
        );
      },
    };
  }

  /** Runs at most one category-detail seller request per Alarm for both direct and Relay shops. */
  private async runDetailCategoryEnrichmentStep(
    execution: StoredExecution,
    plugin: ShopPlugin,
  ): Promise<boolean> {
    const runId = execution.message.collectionRunId;
    if (!runId || !plugin.capabilities.detailCategoryEvidence) return false;

    const startedAtMs = Date.now();
    const relay = isRelayPlugin(plugin);
    if (!relay && Date.now() < execution.nextOriginNotBeforeMs && !execution.permit) {
      await this.ctx.storage.setAlarm(alarmAt(execution.nextOriginNotBeforeMs));
      return true;
    }

    const fenceAccounting = accountReads(this.env.DB);
    const commitAccounting = accountReads(this.env.DB);
    const currentDetailDbUsage = (): StoredDetailDbUsage =>
      accumulatedDetailDbUsage(
        execution.detailDbUsage,
        dbUsageMetrics(fenceAccounting),
        dbUsageMetrics(commitAccounting),
      );
    const planContext = this.detailPlanContext(plugin, fenceAccounting.db);
    const progress = await detailEnrichmentProgress(planContext, runId);
    const target = await nextUncommittedDetailTargetWithInput(planContext, progress);
    const targetUrl = target?.url;

    if (!targetUrl) {
      if (execution.permit || execution.relayPermit || execution.detailTargetUrl) {
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
          ...execution,
          detailDbUsage: currentDetailDbUsage(),
          permit: undefined,
          relayPermit: undefined,
          detailTargetUrl: undefined,
        });
        await this.ctx.storage.setAlarm(alarmAt(Date.now()));
        return true;
      }
      if (execution.detailDbUsageLogged) return false;
      const detailUsage = currentDetailDbUsage();
      const total = sumDbUsageMetrics(detailUsage.fence, detailUsage.commit);
      // Persist the durable marker before logging so every later finalization retry skips emission.
      execution.detailDbUsage = undefined;
      execution.detailDbUsageLogged = true;
      await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, execution);
      console.log(
        JSON.stringify({
          event: "detail_enrichment_db_usage",
          shopKey: plugin.key,
          runId,
          targetCount: progress.targetCount,
          fenceRowsRead: detailUsage.fence.rowsRead,
          commitRowsRead: detailUsage.commit.rowsRead,
          fenceStatements: detailUsage.fence.statementCount,
          commitStatements: detailUsage.commit.statementCount,
          ...total,
        }),
      );
      return false;
    }

    if (execution.detailTargetUrl && execution.detailTargetUrl !== targetUrl) {
      await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
        ...execution,
        detailDbUsage: currentDetailDbUsage(),
        permit: undefined,
        relayPermit: undefined,
        detailTargetUrl: undefined,
      });
      await this.ctx.storage.setAlarm(alarmAt(Date.now()));
      return true;
    }

    const settings = getCrawlerSettings(this.env);
    const requestDelayMs = getShopRequestDelayMs(
      this.env,
      plugin.definition,
      settings.requestDelayMs,
    );
    let directPermit = execution.detailTargetUrl === targetUrl ? execution.permit : undefined;
    let relayPermit = execution.detailTargetUrl === targetUrl ? execution.relayPermit : undefined;

    if (!directPermit && !relayPermit) {
      try {
        if (relay) {
          relayPermit = await prepareRelayFetchPermit(relayConfiguration(this.env), targetUrl, {
            userAgent: settings.userAgent,
            requestDelayMs,
          });
        } else {
          directPermit = await prepareDirectFetchPermit(targetUrl, {
            baseUrl: plugin.baseUrl,
            userAgent: settings.userAgent,
            requestDelayMs,
            fetchFn: globalThis.fetch,
          });
        }
      } catch (error) {
        await recordCrawlFetchDetailPage(commitAccounting.db, {
          runId,
          targetUrl,
          errorMessage: error instanceof Error ? error.message : String(error),
          fetchedAt: new Date().toISOString(),
        });
        // The fence now records this target as attempted, so the plan may move past it. After the
        // commit, never before: the reverse order drops the target on a failure between the two.
        await advanceDetailPlanCursor(planContext, progress, progress.cursor + 1);
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
          ...execution,
          detailDbUsage: currentDetailDbUsage(),
          permit: undefined,
          relayPermit: undefined,
          detailTargetUrl: undefined,
        });
        await this.ctx.storage.setAlarm(alarmAt(Date.now()));
        console.warn(
          JSON.stringify({
            event: "crawl_do_detail_fetch_prepare_failed",
            shopKey: plugin.key,
            runId,
            targetUrl,
            message: error instanceof Error ? error.message : String(error),
            activeMs: Date.now() - startedAtMs,
          }),
        );
        return true;
      }

      const prepared = relayPermit || directPermit;
      if (!prepared) throw new Error(`detail fetch permit was not prepared for ${plugin.key}`);
      await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
        ...execution,
        detailDbUsage: currentDetailDbUsage(),
        permit: directPermit,
        relayPermit,
        detailTargetUrl: targetUrl,
      });
      await this.ctx.storage.setAlarm(alarmAt(prepared.notBeforeMs));
      console.log(
        JSON.stringify({
          event: "crawl_do_detail_fetch_prepared",
          shopKey: plugin.key,
          runId,
          targetUrl,
          transport: relay ? "relay" : "direct",
          effectiveDelayMs: prepared.effectiveDelayMs,
          notBeforeMs: prepared.notBeforeMs,
          ...(relayPermit ? { expiresAtMs: relayPermit.expiresAtMs } : {}),
          activeMs: Date.now() - startedAtMs,
        }),
      );
      return true;
    }

    const notBeforeMs = (relayPermit || directPermit)?.notBeforeMs || 0;
    if (Date.now() < notBeforeMs) {
      await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
        ...execution,
        detailDbUsage: currentDetailDbUsage(),
      });
      await this.ctx.storage.setAlarm(alarmAt(notBeforeMs));
      return true;
    }
    if (relayPermit && Date.now() >= relayPermit.expiresAtMs) {
      await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
        ...execution,
        detailDbUsage: currentDetailDbUsage(),
        permit: undefined,
        relayPermit: undefined,
        detailTargetUrl: undefined,
      });
      await this.ctx.storage.setAlarm(alarmAt(Date.now()));
      return true;
    }

    if (directPermit) {
      execution.permit = undefined;
      execution.nextOriginNotBeforeMs = Date.now() + directPermit.effectiveDelayMs;
      await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
        ...execution,
        detailDbUsage: currentDetailDbUsage(),
      });
    }
    let html: string | null = null;
    let evidence: import("../catalog/types.js").CategoryEvidenceInput[] | undefined;
    let htmlBytes = 0;
    let errorMessage: string | null = null;
    try {
      if (relayPermit) {
        html = await fetchPreparedRelayHtmlPage(
          relayConfiguration(this.env),
          relayPermit,
          targetUrl,
          { userAgent: settings.userAgent },
        );
      } else if (directPermit) {
        html = await fetchPreparedDirectHtmlPage(directPermit, targetUrl, {
          userAgent: settings.userAgent,
          fetchFn: globalThis.fetch,
        });
      }
      htmlBytes = html == null ? 0 : new TextEncoder().encode(html).byteLength;
      if (html !== null && target?.product) {
        const extracted = await plugin.capabilities.detailCategoryEvidence.extract(
          html,
          target.product,
        );
        evidence = Array.isArray(extracted) ? extracted : [];
        html = null;
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      html = null;
    }
    await recordCrawlFetchDetailPage(commitAccounting.db, {
      runId,
      targetUrl,
      html,
      errorMessage,
      fetchedAt: new Date().toISOString(),
      evidence,
      htmlBytes,
    });
    // D1 commit first, then the cursor. A kill in between leaves the cursor pointing at a committed
    // target, which the skip in `nextUncommittedDetailTarget` resolves without re-asking the seller.
    await advanceDetailPlanCursor(planContext, progress, progress.cursor + 1);
    const nextOriginNotBeforeMs = directPermit
      ? Date.now() + directPermit.effectiveDelayMs
      : execution.nextOriginNotBeforeMs;
    await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
      ...execution,
      detailDbUsage: currentDetailDbUsage(),
      nextOriginNotBeforeMs,
      permit: undefined,
      relayPermit: undefined,
      detailTargetUrl: undefined,
    });
    await this.ctx.storage.setAlarm(alarmAt(Date.now()));
    console.log(
      JSON.stringify({
        event: "crawl_do_detail_fetch_completed",
        shopKey: plugin.key,
        runId,
        targetUrl,
        transport: relay ? "relay" : "direct",
        status: errorMessage ? "failed" : "fetched",
        htmlBytes,
        retainedHtmlBytes: html == null ? 0 : htmlBytes,
        activeMs: Date.now() - startedAtMs,
      }),
    );
    return true;
  }

  private async runExecutionStep(execution: StoredExecution): Promise<void> {
    const startedAtMs = Date.now();
    const { message } = execution;
    const plugin = getShopPlugin(message.shopKey);
    if (!plugin || !isCrawlDoEligible(plugin.key)) {
      await this.ctx.storage.delete(EXECUTION_STORAGE_KEY);
      throw new Error(`crawl DO shop became ineligible: ${message.shopKey}`);
    }

    try {
      if (execution.inventoryRecheckPending && message.collectionRunId) {
        const session = await getCrawlFetchSession(this.env.DB, message.collectionRunId);
        if (session?.status === "completed") {
          await this.runInventoryRecheckStep(execution, plugin);
          return;
        }
        if (session?.status === "failed") {
          await this.ctx.storage.delete(EXECUTION_STORAGE_KEY);
          return;
        }
      }

      const continuation = message.continuation;
      if (
        continuation?.phase === "finalize" &&
        (await this.runDetailCategoryEnrichmentStep(execution, plugin))
      ) {
        return;
      }

      // A page receipt can outlive the following DO command write. Recover it before preparing
      // another permit; an uncommitted attempt must instead pass through PREPARE and its delay.
      const attemptedPage =
        execution.directFetchAttempted &&
        continuation?.phase === "fetch" &&
        continuation.pageKey &&
        message.collectionRunId
          ? await getCrawlFetchPage(this.env.DB, message.collectionRunId, continuation.pageKey)
          : null;
      const committedDirectPage = attemptedPage != null && attemptedPage.state !== "pending";
      let preparationError: unknown = null;
      if (
        !committedDirectPage &&
        !execution.permit &&
        !execution.relayPermit &&
        continuation?.phase === "fetch" &&
        continuation.pageKey
      ) {
        if (Date.now() < execution.nextOriginNotBeforeMs) {
          await this.ctx.storage.setAlarm(alarmAt(execution.nextOriginNotBeforeMs));
          return;
        }
        const settings = getCrawlerSettings(this.env);
        const requestDelayMs = getShopRequestDelayMs(
          this.env,
          plugin.definition,
          settings.requestDelayMs,
        );
        try {
          if (isRelayPlugin(plugin)) {
            const relayPermit = await prepareRelayFetchPermit(
              relayConfiguration(this.env),
              continuation.pageKey,
              { userAgent: settings.userAgent, requestDelayMs },
            );
            await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
              ...execution,
              relayPermit,
            });
            await this.ctx.storage.setAlarm(alarmAt(relayPermit.notBeforeMs));
            console.log(
              JSON.stringify({
                event: "crawl_do_relay_fetch_prepared",
                shopKey: plugin.key,
                requestedAt: message.requestedAt,
                jobId: executionIdentity(message),
                pageKey: continuation.pageKey,
                effectiveDelayMs: relayPermit.effectiveDelayMs,
                notBeforeMs: relayPermit.notBeforeMs,
                expiresAtMs: relayPermit.expiresAtMs,
              }),
            );
            return;
          }

          const permit = await prepareDirectFetchPermit(continuation.pageKey, {
            baseUrl: plugin.baseUrl,
            userAgent: settings.userAgent,
            requestDelayMs,
            fetchFn: globalThis.fetch,
          });
          await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
            ...execution,
            permit,
            directFetchAttempted: undefined,
          });
          await this.ctx.storage.setAlarm(alarmAt(permit.notBeforeMs));
          console.log(
            JSON.stringify({
              event: "crawl_do_fetch_prepared",
              shopKey: plugin.key,
              requestedAt: message.requestedAt,
              jobId: executionIdentity(message),
              pageKey: continuation.pageKey,
              effectiveDelayMs: permit.effectiveDelayMs,
              notBeforeMs: permit.notBeforeMs,
            }),
          );
          return;
        } catch (error) {
          preparationError = error;
        }
      }

      if (execution.permit && Date.now() < execution.permit.notBeforeMs) {
        await this.ctx.storage.setAlarm(alarmAt(execution.permit.notBeforeMs));
        return;
      }
      if (execution.relayPermit && Date.now() < execution.relayPermit.notBeforeMs) {
        await this.ctx.storage.setAlarm(alarmAt(execution.relayPermit.notBeforeMs));
        return;
      }
      if (execution.relayPermit && Date.now() >= execution.relayPermit.expiresAtMs) {
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
          ...execution,
          relayPermit: undefined,
          detailTargetUrl: undefined,
        });
        await this.ctx.storage.setAlarm(alarmAt(Date.now()));
        return;
      }

      let activeExecution = execution;
      if (
        continuation?.phase === "finalize" &&
        plugin.capabilities.inventoryRecheck &&
        !execution.inventoryRecheckPending
      ) {
        activeExecution = { ...execution, inventoryRecheckPending: true };
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, activeExecution);
      }

      const directPermit = activeExecution.permit;
      const relayPermit = activeExecution.relayPermit;
      const preparedRelayConfig = relayPermit ? relayConfiguration(this.env) : null;
      if (directPermit && continuation?.phase === "fetch") {
        // Persist before I/O, including before response decoding or inline parser CPU work. A
        // failure at any later boundary cannot reuse an already eligible seller capability.
        activeExecution = {
          ...activeExecution,
          permit: undefined,
          directFetchAttempted: true,
          nextOriginNotBeforeMs: Date.now() + directPermit.effectiveDelayMs,
        };
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, activeExecution);
      }
      // Read rather than plan: this only surfaces the instant an existing plan already recorded, so
      // a run that never entered the detail phase is not made to pay for planning here.
      const detailDecisionAt = await this.detailDecisionAt(execution.message.collectionRunId);
      const collectionProgress: CollectionProgressState | undefined =
        "collectionProgress" in activeExecution
          ? { value: activeExecution.collectionProgress ?? null }
          : undefined;
      const result = await executeResumableCrawlStep(
        withoutInlineInventoryRecheck(this.env, plugin),
        message,
        {
          continuationDelivery: "return_only",
          collectionProgress,
          initializeOnly: !message.continuation,
          parseFetchedPage: true,
          requireStagedDetailFetches: Boolean(plugin.capabilities.detailCategoryEvidence),
          // Finalization re-runs the same time-dependent enrichment policy. Handing it the instant
          // the plan was built keeps the two answers identical, so a cache entry expiring during
          // the paced fetches cannot make finalization demand a URL the plan never staged.
          ...(detailDecisionAt ? { detailDecisionAt } : {}),
          ...(preparationError
            ? {
                fetchHtmlPage: async () => {
                  throw preparationError;
                },
              }
            : relayPermit && preparedRelayConfig
              ? {
                  fetchHtmlPage: (url, options) =>
                    fetchPreparedRelayHtmlPage(preparedRelayConfig, relayPermit, url, {
                      userAgent: options.userAgent,
                    }),
                }
              : directPermit
                ? {
                    fetchHtmlPage: (url, options) =>
                      fetchPreparedDirectHtmlPage(directPermit, url, {
                        userAgent: options.userAgent,
                        fetchFn: globalThis.fetch,
                      }),
                  }
                : {}),
        },
      );
      const nextOriginNotBeforeMs = directPermit
        ? Date.now() + directPermit.effectiveDelayMs
        : activeExecution.nextOriginNotBeforeMs;

      if (result.kind === "continued") {
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
          ...activeExecution,
          message: result.continuationMessage,
          ...(collectionProgress ? { collectionProgress: collectionProgress.value } : {}),
          nextOriginNotBeforeMs,
          permit: undefined,
          directFetchAttempted: undefined,
          relayPermit: undefined,
          detailTargetUrl: undefined,
        });
        await this.ctx.storage.setAlarm(alarmAt(Date.now()));
        console.log(
          JSON.stringify({
            event: "crawl_do_step",
            shopKey: plugin.key,
            runId: result.runId,
            sequence: result.sequence,
            phase: result.phase,
            pageKey: result.pageKey,
            transport: isRelayPlugin(plugin) ? "relay" : "direct",
            activeMs: Date.now() - startedAtMs,
          }),
        );
        return;
      }

      if (result.kind === "retry") {
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
          ...activeExecution,
          nextOriginNotBeforeMs,
          permit: undefined,
          directFetchAttempted: undefined,
          relayPermit: undefined,
          detailTargetUrl: undefined,
        });
        await this.ctx.storage.setAlarm(
          alarmAt(Date.now() + Math.max(1, result.retryAfterSeconds) * 1000),
        );
        console.log(
          JSON.stringify({
            event: "crawl_do_retry",
            shopKey: plugin.key,
            runId: result.runId || null,
            reason: result.reason,
            retryAfterSeconds: result.retryAfterSeconds,
            activeMs: Date.now() - startedAtMs,
          }),
        );
        return;
      }

      if (activeExecution.inventoryRecheckPending && result.runId) {
        const session = await getCrawlFetchSession(this.env.DB, result.runId);
        if (session?.status === "completed") {
          await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
            ...activeExecution,
            message: { ...message, collectionRunId: result.runId },
            nextOriginNotBeforeMs: 0,
            permit: undefined,
            relayPermit: undefined,
            detailTargetUrl: undefined,
          });
          await this.ctx.storage.setAlarm(alarmAt(Date.now()));
          console.log(
            JSON.stringify({
              event: "crawl_do_inventory_recheck_scheduled",
              shopKey: plugin.key,
              runId: result.runId,
              activeMs: Date.now() - startedAtMs,
            }),
          );
          return;
        }
      }

      await this.ctx.storage.delete(EXECUTION_STORAGE_KEY);
      console.log(
        JSON.stringify({
          event: "crawl_do_completed",
          shopKey: plugin.key,
          runId: result.runId || null,
          status: result.result.status,
          activeMs: Date.now() - startedAtMs,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "crawl_do_alarm_failed",
          shopKey: message.shopKey,
          requestedAt: message.requestedAt,
          jobId: executionIdentity(message),
          activeMs: Date.now() - startedAtMs,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }
}
