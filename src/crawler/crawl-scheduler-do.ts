import { DurableObject } from "cloudflare:workers";

import { getCrawlerSettings, getShopRequestDelayMs } from "../config.js";
import { getCrawlFetchSession } from "../db/crawl-fetch-session-repository.js";
import { crawlDispatchToken } from "../db/shop-state-repository.js";
import {
  fetchPreparedDirectHtmlPage,
  prepareDirectFetchPermit,
  type DirectFetchPermit,
} from "./direct-pacing.js";
import {
  CRAWL_SCHEDULER_COMMAND_VERSION,
  CRAWL_SCHEDULER_OBSERVE_PATH,
  CRAWL_SCHEDULER_START_PATH,
  isCrawlDoCanaryEligible,
  type CrawlSchedulerObserveCommand,
  type CrawlSchedulerStartCommand,
} from "./orchestration.js";
import {
  consumeResumableCrawlMessage,
  type ResumableCrawlQueueMessage,
} from "./resumable-queue-consumer.js";
import { getShopPlugin } from "./shops/index.js";

const OBSERVATION_STORAGE_KEY = "phase1_checkpoint_observation";
const EXECUTION_STORAGE_KEY = "phase2_crawl_execution";
const INITIAL_OBSERVATION_DELAY_MS = 10_000;
const RETRY_OBSERVATION_DELAY_MS = 30_000;
const MAX_OBSERVATION_ATTEMPTS = 3;
const MIN_ALARM_DELAY_MS = 1;

interface StoredObservation {
  command: CrawlSchedulerObserveCommand;
  attempts: number;
  scheduledAt: string;
}

interface StoredExecution {
  message: ResumableCrawlQueueMessage;
  acceptedAt: string;
  nextOriginNotBeforeMs: number;
  permit?: DirectFetchPermit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCrawlSchedulerObserveCommand(
  value: unknown,
): CrawlSchedulerObserveCommand | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== CRAWL_SCHEDULER_COMMAND_VERSION) return null;
  if (value.type !== "observe_checkpoint") return null;
  for (const field of ["shopKey", "requestedAt", "jobId", "runId"] as const) {
    if (typeof value[field] !== "string" || !value[field]) return null;
  }
  return {
    schemaVersion: CRAWL_SCHEDULER_COMMAND_VERSION,
    type: "observe_checkpoint",
    shopKey: value.shopKey as string,
    requestedAt: value.requestedAt as string,
    jobId: value.jobId as string,
    runId: value.runId as string,
  };
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
      ...(message.lane === "fast" || message.lane === "heavy" || message.lane === "relay"
        ? { lane: message.lane }
        : {}),
    },
  };
}

function executionIdentity(message: ResumableCrawlQueueMessage): string {
  return message.jobId || crawlDispatchToken(message.shopKey, message.requestedAt);
}

function alarmAt(timestampMs: number): number {
  return Math.max(Date.now() + MIN_ALARM_DELAY_MS, timestampMs);
}

/**
 * Per-shop crawl control plane.
 *
 * Phase 1 observation remains available for non-canary shops. Phase 2 adds one authoritative
 * canary path: the DO persists only immutable continuation/timing metadata, while D1 remains the
 * source of truth for crawl progress. Every Alarm executes at most one bounded state-machine step.
 * Seller pacing is split into `robots -> Alarm -> target`, so no request-delay sleep runs inside a
 * DO invocation and the old seller-origin ordering is preserved.
 */
export class CrawlScheduler extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    if (url.pathname === CRAWL_SCHEDULER_START_PATH) return this.startCrawl(request);
    if (url.pathname === CRAWL_SCHEDULER_OBSERVE_PATH) return this.observeCheckpoint(request);
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
    if (!isCrawlDoCanaryEligible(message.shopKey)) {
      return new Response("shop is not eligible for Phase 2 canary", { status: 400 });
    }

    const existing = await this.ctx.storage.get<StoredExecution>(EXECUTION_STORAGE_KEY);
    if (existing) {
      if (
        existing.message.shopKey === message.shopKey &&
        executionIdentity(existing.message) === executionIdentity(message)
      ) {
        // Recovery/redelivery is idempotent. An immediate Alarm is safe: pacing timestamps and D1
        // continuation_sequence are rechecked before any seller request.
        await this.ctx.storage.setAlarm(alarmAt(Date.now()));
        return new Response(null, { status: 202 });
      }
      console.warn(
        JSON.stringify({
          event: "crawl_do_canary_busy",
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
    });
    await this.ctx.storage.setAlarm(alarmAt(Date.now()));
    console.log(
      JSON.stringify({
        event: "crawl_do_canary_accepted",
        shopKey: message.shopKey,
        requestedAt: message.requestedAt,
        jobId: executionIdentity(message),
        batchRunId: message.batchRunId || null,
        lane: message.lane || null,
        acceptedAt,
      }),
    );
    return new Response(null, { status: 202 });
  }

  private async observeCheckpoint(request: Request): Promise<Response> {
    let command: CrawlSchedulerObserveCommand | null = null;
    try {
      command = parseCrawlSchedulerObserveCommand(await request.json());
    } catch {
      // handled as invalid input below
    }
    if (!command) return new Response("invalid command", { status: 400 });

    const existing = await this.ctx.storage.get<StoredObservation>(OBSERVATION_STORAGE_KEY);
    if (existing) {
      if (existing.command.jobId === command.jobId && existing.command.runId === command.runId) {
        return new Response(null, { status: 202 });
      }
      console.warn(
        JSON.stringify({
          event: "crawl_do_shadow_busy",
          shopKey: command.shopKey,
          requestedAt: command.requestedAt,
          jobId: command.jobId,
          runId: command.runId,
          activeJobId: existing.command.jobId,
          activeRunId: existing.command.runId,
        }),
      );
      return new Response("scheduler busy", { status: 409 });
    }

    const scheduledAt = new Date().toISOString();
    await this.ctx.storage.put<StoredObservation>(OBSERVATION_STORAGE_KEY, {
      command,
      attempts: 0,
      scheduledAt,
    });
    await this.ctx.storage.setAlarm(Date.now() + INITIAL_OBSERVATION_DELAY_MS);
    console.log(
      JSON.stringify({
        event: "crawl_do_shadow_accepted",
        shopKey: command.shopKey,
        requestedAt: command.requestedAt,
        jobId: command.jobId,
        runId: command.runId,
        scheduledAt,
      }),
    );
    return new Response(null, { status: 202 });
  }

  async alarm(): Promise<void> {
    const execution = await this.ctx.storage.get<StoredExecution>(EXECUTION_STORAGE_KEY);
    if (execution) {
      await this.runCanaryStep(execution);
      return;
    }
    await this.runShadowObservation();
  }

  private async runCanaryStep(execution: StoredExecution): Promise<void> {
    const startedAtMs = Date.now();
    const { message } = execution;
    const plugin = getShopPlugin(message.shopKey);
    if (!plugin || !isCrawlDoCanaryEligible(plugin.key)) {
      await this.ctx.storage.delete(EXECUTION_STORAGE_KEY);
      throw new Error(`crawl DO canary became ineligible: ${message.shopKey}`);
    }

    try {
      const continuation = message.continuation;
      if (!execution.permit && continuation?.phase === "fetch" && continuation.pageKey) {
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
        const permit = await prepareDirectFetchPermit(continuation.pageKey, {
          baseUrl: plugin.baseUrl,
          userAgent: settings.userAgent,
          requestDelayMs,
          fetchFn: globalThis.fetch,
        });
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
          ...execution,
          permit,
        });
        await this.ctx.storage.setAlarm(alarmAt(permit.notBeforeMs));
        console.log(
          JSON.stringify({
            event: "crawl_do_canary_fetch_prepared",
            shopKey: plugin.key,
            requestedAt: message.requestedAt,
            jobId: executionIdentity(message),
            pageKey: continuation.pageKey,
            effectiveDelayMs: permit.effectiveDelayMs,
            notBeforeMs: permit.notBeforeMs,
          }),
        );
        return;
      }

      if (execution.permit && Date.now() < execution.permit.notBeforeMs) {
        await this.ctx.storage.setAlarm(alarmAt(execution.permit.notBeforeMs));
        return;
      }

      const permit = execution.permit;
      const result = await consumeResumableCrawlMessage(this.env, message, {
        continuationDelivery: "return_only",
        initializeOnly: !message.continuation,
        ...(permit
          ? {
              fetchHtmlPage: (url, options) =>
                fetchPreparedDirectHtmlPage(permit, url, {
                  userAgent: options.userAgent,
                  fetchFn: globalThis.fetch,
                }),
            }
          : {}),
      });
      const nextOriginNotBeforeMs = permit
        ? Date.now() + permit.effectiveDelayMs
        : execution.nextOriginNotBeforeMs;

      if (result.kind === "continued") {
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
          ...execution,
          message: result.continuationMessage,
          nextOriginNotBeforeMs,
          permit: undefined,
        });
        await this.ctx.storage.setAlarm(alarmAt(Date.now()));
        console.log(
          JSON.stringify({
            event: "crawl_do_canary_step",
            shopKey: plugin.key,
            runId: result.runId,
            sequence: result.sequence,
            phase: result.phase,
            pageKey: result.pageKey,
            activeMs: Date.now() - startedAtMs,
          }),
        );
        return;
      }

      if (result.kind === "retry") {
        await this.ctx.storage.put<StoredExecution>(EXECUTION_STORAGE_KEY, {
          ...execution,
          nextOriginNotBeforeMs,
          permit: undefined,
        });
        await this.ctx.storage.setAlarm(
          alarmAt(Date.now() + Math.max(1, result.retryAfterSeconds) * 1000),
        );
        console.log(
          JSON.stringify({
            event: "crawl_do_canary_retry",
            shopKey: plugin.key,
            runId: result.runId || null,
            reason: result.reason,
            retryAfterSeconds: result.retryAfterSeconds,
            activeMs: Date.now() - startedAtMs,
          }),
        );
        return;
      }

      await this.ctx.storage.delete(EXECUTION_STORAGE_KEY);
      console.log(
        JSON.stringify({
          event: "crawl_do_canary_completed",
          shopKey: plugin.key,
          runId: result.runId || null,
          status: result.result.status,
          activeMs: Date.now() - startedAtMs,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "crawl_do_canary_alarm_failed",
          shopKey: message.shopKey,
          requestedAt: message.requestedAt,
          jobId: executionIdentity(message),
          activeMs: Date.now() - startedAtMs,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      // Durable Object alarms are at-least-once and retry automatically. Keep the stored command and
      // rethrow so infrastructure failure cannot be mistaken for a seller/crawl failure.
      throw error;
    }
  }

  private async runShadowObservation(): Promise<void> {
    const observation = await this.ctx.storage.get<StoredObservation>(OBSERVATION_STORAGE_KEY);
    if (!observation) return;

    const { command } = observation;
    const attempt = observation.attempts + 1;
    const session = await getCrawlFetchSession(this.env.DB, command.runId);
    if (!session && attempt < MAX_OBSERVATION_ATTEMPTS) {
      await this.ctx.storage.put<StoredObservation>(OBSERVATION_STORAGE_KEY, {
        ...observation,
        attempts: attempt,
      });
      await this.ctx.storage.setAlarm(Date.now() + RETRY_OBSERVATION_DELAY_MS);
      console.log(
        JSON.stringify({
          event: "crawl_do_shadow_checkpoint_pending",
          shopKey: command.shopKey,
          requestedAt: command.requestedAt,
          jobId: command.jobId,
          runId: command.runId,
          attempt,
        }),
      );
      return;
    }

    console.log(
      JSON.stringify({
        event: "crawl_do_shadow_checkpoint_observed",
        shopKey: command.shopKey,
        requestedAt: command.requestedAt,
        jobId: command.jobId,
        runId: command.runId,
        attempt,
        checkpointFound: Boolean(session),
        status: session?.status || null,
        continuationSequence: session?.continuation_sequence ?? null,
        nextPhase: session?.next_phase ?? null,
        nextPageKey: session?.next_page_key ?? null,
        pagesFetched: session?.pages_fetched ?? null,
        pagesParsed: session?.pages_parsed ?? null,
        updatedAt: session?.updated_at || null,
      }),
    );
    await this.ctx.storage.delete(OBSERVATION_STORAGE_KEY);
  }
}
