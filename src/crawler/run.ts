import {
  getCrawlerSettings,
  getShopEnabled,
  getShopIntervalMinutes,
  getShopMaxPages,
  getShopRequestDelayMs,
} from "../config.js";
import { saveDataQualityRun } from "../db/data-quality-repository.js";
import { syncProductMetadata } from "../db/product-metadata-repository.js";
import { resolveProductCatalogFields } from "../db/model-repository.js";
import { upsertProducts } from "../db/product-write-repository.js";
import {
  getShopState,
  listShopStates,
  markShopAttempt,
  markShopFailure,
  markShopProjectionComplete,
  markShopSuccess,
} from "../db/shop-state-repository.js";
import {
  finishCrawlRunFailure,
  finishCrawlRunSuccess,
  startCrawlRun,
} from "../db/crawl-run-repository.js";
import {
  clearCrawlRunWorkItems,
  nextPendingCrawlRunStage,
  recordCrawlRunWorkSet,
} from "../db/crawl-run-continuation-repository.js";
import {
  DERIVED_WORK_BUDGET_MS,
  crawlStageFailureEvent,
  crawlStageScope,
  drainCrawlRunStage,
  emptyDerivedWorkMetrics,
  type DerivedWorkMetrics,
} from "./crawl-continuation.js";
import { recordCrawlWorkloadObservation } from "../db/crawl-workload-repository.js";
import { archiveEvidence } from "../evidence/evidence-archive.js";
import { enrichProductCategories } from "./category-enricher.js";
import { createCrawlStageRecorder } from "./crawl-stages.js";
import { SHOP_PLUGINS, getShopActivityPolicy } from "./shops/index.js";
import { createTransport, isTransportConfigured } from "./transport.js";
import { errorMessage } from "../types.js";
import type { NormalizedCatalogProduct } from "../catalog/types.js";
import type {
  EvidenceArchiveResult,
  EvidenceReason,
  QualityCounts,
  QualityEvaluation,
  QueryableDatabase,
  ShopSyncStateRow,
} from "../db/types.js";
import type { CrawlStageRecorder } from "./crawl-stages.js";
import type {
  AugmentedCrawlError,
  CrawlerEnv,
  CrawlResult,
  HtmlTransport,
  RobotsCache,
  ShopPlugin,
} from "./types.js";
import {
  coverageDecision,
  discoverPages,
  initialPageQueue,
  shouldContinueAfterEmpty,
  targetUrl,
} from "./strategies.js";

type RuntimeEnv = CrawlerEnv & { DB: QueryableDatabase };

interface CrawlShopOptions {
  force?: boolean;
  now?: Date;
  fetchFn?: typeof fetch;
}

interface EvidenceMetrics {
  expected: number;
  archived: number;
  failed: number;
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function isConfigured(env: CrawlerEnv, adapter: ShopPlugin): boolean {
  return isTransportConfigured(env, adapter.capabilities.transport?.kind);
}

function logUnclassifiedProducts(
  adapter: ShopPlugin,
  products: readonly NormalizedCatalogProduct[],
): void {
  const unresolved = products.filter((product) => product.classificationStatus !== "classified");
  if (!unresolved.length) return;
  console.warn(
    JSON.stringify({
      event: "catalog_unclassified",
      shopKey: adapter.key,
      count: unresolved.length,
      samples: unresolved.slice(0, 5).map((product) => ({
        sourceId: product.sourceId,
        rawCategory: product.rawCategory,
        title: product.title,
        state: product.classificationState || "unclassified",
        candidates: product.candidateCategoryIds || [],
      })),
    }),
  );
}

function crawlEvidenceError(message: string, reason: EvidenceReason): AugmentedCrawlError {
  return Object.assign(new Error(message), { evidenceReason: reason });
}

function evidenceOutcome(
  metrics: EvidenceMetrics,
  result: EvidenceArchiveResult | null | undefined,
): void {
  if (!result || result.status === "skipped") return;
  if (result.status === "archived" || result.status === "deduplicated") {
    metrics.archived += 1;
  } else if (result.status === "failed" || result.status === "suppressed") {
    metrics.failed += 1;
  }
}

async function safeSaveDataQuality(
  env: RuntimeEnv,
  adapter: ShopPlugin,
  runId: number | null,
  evaluatedAt: string,
  run: Partial<QualityCounts>,
): Promise<(QualityEvaluation & { evaluatedAt: string; crawlRunId: number | null }) | null> {
  try {
    const quality = await saveDataQualityRun(env.DB, {
      shopKey: adapter.key,
      crawlRunId: runId,
      evaluatedAt,
      run,
      thresholdOverrides: adapter.capabilities.dataQuality?.thresholds || {},
    });
    console.log(
      JSON.stringify({
        event: "data_quality_evaluated",
        shop: adapter.key,
        crawlRunId: runId,
        status: quality.status,
        total: quality.counts.totalItems,
        manufacturerUnknownRate: quality.metrics.manufacturerUnknown.rate,
        categoryUnclassifiedRate: quality.metrics.categoryUnclassified.rate,
        identityUnresolvedRate: quality.metrics.identityUnresolved.rate,
        inventoryUnknownRate: quality.metrics.inventoryUnknown.rate,
        modelMissingRate: quality.metrics.modelMissing.rate,
        parseFailureRate: quality.metrics.parserFailure.rate,
        evidenceCoverageRate: quality.metrics.evidenceCoverage.rate,
        itemCountChangeRate: quality.metrics.itemCount.changeRate,
      }),
    );
    return quality;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "data_quality_evaluation_failure",
        shop: adapter.key,
        crawlRunId: runId,
        message: errorMessage(error),
      }),
    );
    return null;
  }
}

interface DerivedProductState extends DerivedWorkMetrics {
  /** True when work remains for the continuation sweep, for either reason below. */
  pending: boolean;
  /**
   * True when the invocation ran out of budget rather than hitting a failing stage.
   *
   * The two are kept apart because this one is the workload signal: needing a second invocation is
   * evidence about how large the shop is, while a failing projection is evidence about D1.
   */
  deferred: boolean;
}

interface DerivedWorkOptions {
  /** Listings this crawl changed, which is what the run-scoped stages were given. */
  workSetSize: number;
  budgetMs: number;
  /** Start of the whole invocation, so fetch and parse count against the same budget. */
  startedAtMs: number;
}

/**
 * Drives everything downstream of the listing write, in dependency order and within a budget.
 *
 * The stages, their order and their chunking all come from the durable checkpoint written just
 * before this, so the crawl that owns the work runs exactly the code the cron sweep would run if
 * this invocation were killed. Stopping on the budget is therefore an ordinary outcome rather than
 * a failure: the remaining chunks are already durable and the sweep picks them up.
 */
async function syncDerivedProductState(
  env: RuntimeEnv,
  adapter: ShopPlugin,
  observedAt: string,
  stages: CrawlStageRecorder,
  crawlRunId: number,
  { workSetSize, budgetMs, startedAtMs }: DerivedWorkOptions,
): Promise<DerivedProductState> {
  const run = { crawlRunId, shopKey: adapter.key, generation: observedAt };
  const metrics = emptyDerivedWorkMetrics();

  const defer = (stage: string): DerivedProductState => {
    console.log(
      JSON.stringify({
        event: "crawl_derived_work_deferred",
        shopKey: adapter.key,
        crawlRunId,
        stage,
        elapsedMs: Date.now() - startedAtMs,
        budgetMs,
      }),
    );
    return { ...metrics, pending: true, deferred: true };
  };

  for (;;) {
    const checkpoint = await nextPendingCrawlRunStage(env.DB, crawlRunId);
    if (!checkpoint) return { ...metrics, pending: false, deferred: false };
    if (Date.now() - startedAtMs >= budgetMs) return defer(checkpoint.stage);

    let completed: boolean;
    try {
      completed = await stages
        .run(
          checkpoint.stage,
          {
            // Cleanup walks the shop's leftover memberships rather than this run's listings, so the
            // work set size would misdescribe what it was handed.
            ...(crawlStageScope(checkpoint.stage) === "run" ? { inputCount: workSetSize } : {}),
            failureEvent: crawlStageFailureEvent(checkpoint.stage),
            changedCount: (result) => result.changedCount,
          },
          () =>
            drainCrawlRunStage(env.DB, run, checkpoint, {
              budgetMs,
              startedAtMs,
              metrics,
            }),
        )
        .then((result) => result.completed);
    } catch {
      // Reported by the stage recorder, and left pending for the sweep to replay. Later stages read
      // what this one writes, so the crawl stops here rather than projecting against stale state.
      return { ...metrics, pending: true, deferred: false };
    }
    if (!completed) return defer(checkpoint.stage);
  }
}

export function isShopDue(
  state: Partial<Pick<ShopSyncStateRow, "backoff_until" | "last_attempt_at">> | null | undefined,
  intervalMinutes: number,
  now = new Date(),
): boolean {
  if (state?.backoff_until && new Date(state.backoff_until) > now) return false;
  if (!state?.last_attempt_at) return true;
  return now.getTime() - new Date(state.last_attempt_at).getTime() >= intervalMinutes * 60_000;
}

export function isSuspiciousItemDrop(
  itemCount: number,
  previousItemCount: number,
  { minRatio = 0.5, minBaseline = 20 }: { minRatio?: number; minBaseline?: number } = {},
): boolean {
  if (!Number.isFinite(previousItemCount) || previousItemCount < minBaseline) return false;
  if (!Number.isFinite(itemCount) || itemCount < 0) return true;
  return itemCount / previousItemCount < minRatio;
}

export async function crawlShop(
  env: RuntimeEnv,
  adapter: ShopPlugin,
  { force = false, now = new Date(), fetchFn = fetch }: CrawlShopOptions = {},
): Promise<CrawlResult> {
  const definition = adapter.definition;
  if (!getShopEnabled(env, definition))
    return { shopKey: adapter.key, status: "skipped", reason: "disabled" };
  if (!isConfigured(env, adapter))
    return { shopKey: adapter.key, status: "skipped", reason: "configuration_missing" };

  const intervalMinutes = getShopIntervalMinutes(env, definition);
  const state = await getShopState(env.DB, adapter.key);
  if (!force && !isShopDue(state, intervalMinutes, now))
    return { shopKey: adapter.key, status: "skipped", reason: "not_due" };

  const startedAt = nowIso(now);
  // The budget is measured from here, not from the start of the derived work: what the platform
  // kills is the whole invocation, so fetch and parse have to count against the same clock.
  const invocationStartedAtMs = Date.now();
  const items = new Map<string, NormalizedCatalogProduct>();
  const evidenceMetrics: EvidenceMetrics = { expected: 0, archived: 0, failed: 0 };
  let runId: number | null = null;
  let stages: CrawlStageRecorder | null = null;
  let transport: HtmlTransport | null = null;
  let pageCount = 0;
  let parseAttemptCount = 0;
  let parseFailureCount = 0;
  let reachedEnd = false;
  let coverageIncomplete = false;
  /** Last non-null seller diagnostic; generic orchestration never interprets its shape. */
  let pageDiagnostic: unknown = null;
  let lastEvidenceHtml = "";
  let classificationEvidenceHtml = "";

  // The attempt is recorded first because it is what claims this tick, but everything after it has
  // to reach the terminal accounting below. Run creation, settings and transport construction used
  // to sit outside the boundary, so a failure in any of them escaped uncaught and left the shop
  // with an advanced attempt, no error timestamp and an unchanged failure count — indistinguishable
  // from the state a hard termination leaves, and invisible to shop health either way.
  await markShopAttempt(env.DB, adapter.key, startedAt);
  try {
    runId = await startCrawlRun(env.DB, adapter.key, startedAt);
    const stageRecorder = createCrawlStageRecorder(adapter.key, runId);
    stages = stageRecorder;
    const settings = getCrawlerSettings(env);
    const maxPages = getShopMaxPages(env, definition, settings.maxPagesPerShop);
    const pageLimit = maxPages + adapter.discovery.policy.extraPageBudget;
    const requestDelayMs = getShopRequestDelayMs(env, definition, settings.requestDelayMs);
    const robotsCache: RobotsCache = new Map();
    const activeTransport = createTransport(env, adapter.capabilities.transport?.kind, fetchFn);
    transport = activeTransport;
    const fetchParseStage = stageRecorder.begin("fetch_parse", { inputCount: pageLimit });
    const pageQueue = initialPageQueue(adapter, maxPages, env, { now, intervalMinutes, state });
    const queuedUrls = new Set(pageQueue.map((page) => targetUrl(adapter, page)));

    while (pageQueue.length && pageCount < pageLimit) {
      const page = pageQueue.shift();
      if (!page) break;
      const url = targetUrl(adapter, page);
      let html;
      try {
        html = await activeTransport.fetchHtmlPage(url, {
          baseUrl: adapter.baseUrl,
          userAgent: settings.userAgent,
          requestDelayMs,
          fetchFn,
          robotsCache,
        });
      } catch (error) {
        const fetchError = error instanceof Error ? error : new Error(String(error));
        if (
          /HTTP 404/.test(fetchError.message) &&
          (shouldContinueAfterEmpty(adapter) || items.size === 0)
        ) {
          coverageIncomplete = true;
          continue;
        }
        throw fetchError;
      }

      lastEvidenceHtml = html;
      pageCount += 1;
      const diagnostic = adapter.capabilities.diagnostics?.diagnosePage(html, page);
      if (diagnostic != null) pageDiagnostic = diagnostic;
      let parsed;
      parseAttemptCount += 1;
      try {
        parsed = adapter.parse(html, page);
      } catch (error) {
        parseFailureCount += 1;
        const parseError = error instanceof Error ? error : new Error(String(error));
        const augmentedError: AugmentedCrawlError = parseError;
        augmentedError.evidenceReason = "parser_failure";
        throw augmentedError;
      }
      if (
        !classificationEvidenceHtml &&
        parsed.some((item) => item.classificationStatus !== "classified")
      ) {
        classificationEvidenceHtml = html;
      }

      const discovered = discoverPages(adapter, html, page);
      if (discovered == null) {
        coverageIncomplete = true;
      } else {
        for (const nextPage of discovered) {
          const nextUrl = targetUrl(adapter, nextPage);
          if (queuedUrls.has(nextUrl)) continue;
          if (queuedUrls.size >= pageLimit) {
            coverageIncomplete = true;
            continue;
          }
          queuedUrls.add(nextUrl);
          pageQueue.push(nextPage);
        }
      }

      if (!parsed.length) {
        if (adapter.discovery.discoverTargets) coverageIncomplete = true;
        if (items.size > 0) {
          if (shouldContinueAfterEmpty(adapter)) continue;
          reachedEnd = true;
          break;
        }
      }

      for (const item of parsed) items.set(item.sourceId, item);
    }

    if (pageQueue.length) coverageIncomplete = true;
    if (!items.size) {
      parseFailureCount = Math.max(1, parseFailureCount);
      throw crawlEvidenceError(
        "no products parsed; refusing to mark existing products inactive",
        "parser_failure",
      );
    }

    const { deactivateMissing, validateItemCount } = coverageDecision(adapter, {
      reachedEnd,
      coverageIncomplete,
      queueEmpty: pageQueue.length === 0,
    });
    if (
      validateItemCount &&
      isSuspiciousItemDrop(items.size, Number(state?.last_item_count), {
        minRatio: settings.minItemRatio,
        minBaseline: settings.minItemBaseline,
      })
    ) {
      throw crawlEvidenceError(
        `item count dropped suspiciously from ${state?.last_item_count ?? 0} to ${items.size}; refusing crawl update`,
        "unexpected_item_count",
      );
    }

    fetchParseStage.complete(items.size);

    const observedAt = nowIso(new Date());
    const manufacturerResolvedProducts = await stageRecorder.run(
      "manufacturer_resolution",
      { inputCount: items.size },
      () => resolveProductCatalogFields(env.DB, [...items.values()], { shopKey: adapter.key }),
    );
    const enrichment = await stageRecorder.run(
      "category_enrichment",
      {
        inputCount: manufacturerResolvedProducts.length,
        changedCount: (result) => result.enrichedCount,
      },
      () =>
        enrichProductCategories({
          db: env.DB,
          adapter,
          products: manufacturerResolvedProducts,
          transport: activeTransport,
          fetchOptions: {
            baseUrl: adapter.baseUrl,
            userAgent: settings.userAgent,
            requestDelayMs,
            fetchFn,
            robotsCache,
          },
          now: new Date(observedAt),
        }),
    );
    const products = enrichment.products;
    logUnclassifiedProducts(adapter, products);

    if (enrichment.unresolvedCount > 0) {
      evidenceMetrics.expected += 1;
      if (classificationEvidenceHtml) {
        const result = await archiveEvidence({
          env,
          shopKey: adapter.key,
          crawlRunId: runId,
          reason: "classification_unresolved",
          html: classificationEvidenceHtml,
          capturedAt: observedAt,
        });
        evidenceOutcome(evidenceMetrics, result);
      } else {
        evidenceMetrics.failed += 1;
      }
    }

    const previousItemCount = Number(state?.last_item_count);
    if (
      Number.isFinite(previousItemCount) &&
      previousItemCount > 0 &&
      (items.size - previousItemCount) / previousItemCount <= -0.2
    ) {
      evidenceMetrics.expected += 1;
      const result = await archiveEvidence({
        env,
        shopKey: adapter.key,
        crawlRunId: runId,
        reason: "unexpected_item_count",
        html: lastEvidenceHtml,
        capturedAt: observedAt,
      });
      evidenceOutcome(evidenceMetrics, result);
    }

    const {
      changedCount,
      activityCount,
      touchedCount,
      deactivatedCount,
      featureFactCount,
      derivedSourceIds,
    } = await stageRecorder.run(
      "listing_write",
      { inputCount: products.length, changedCount: (result) => result.changedCount },
      () =>
        upsertProducts(env.DB, adapter.key, products, observedAt, {
          deactivateMissing,
          touchIntervalMinutes: settings.productTouchIntervalMinutes,
          activityPolicy: getShopActivityPolicy(adapter),
        }),
    );
    // The seller is never needed again from here: the listings are written, and this records which
    // of them the derived stages still owe work for. An invocation killed after this point leaves
    // durable pending work instead of losing the whole crawl.
    //
    // Only the delta is recorded. A listing nobody touched projects to exactly what is already
    // stored, so re-projecting the whole inventory on every routine crawl bought nothing and was
    // the work that could not fit in one invocation. Stale resolver versions and catalog edits are
    // replayed by the remediation queue, which is a resumable worker of its own.
    await recordCrawlRunWorkSet(env.DB, {
      crawlRunId: runId,
      generation: observedAt,
      sourceIds: derivedSourceIds,
      recordedAt: observedAt,
    });
    const derivedSourceIdSet = new Set(derivedSourceIds);
    const derived = await syncDerivedProductState(env, adapter, observedAt, stageRecorder, runId, {
      workSetSize: derivedSourceIds.length,
      budgetMs: DERIVED_WORK_BUDGET_MS,
      startedAtMs: invocationStartedAtMs,
    });
    // Metadata follows the same delta as everything else. A listing the seller re-reported
    // unchanged carries the metadata already stored, and the drift a rule change leaves behind is
    // the remediation worker's to replay — it compares `metadata_json` directly and is resumable,
    // where doing it here charged every crawl for a whole-inventory pass to catch a rare case.
    const changedProducts = products.filter((product) => derivedSourceIdSet.has(product.sourceId));
    const metadataChangedCount = await stageRecorder.run(
      "product_metadata",
      { inputCount: changedProducts.length, changedCount: (result) => result },
      () => syncProductMetadata(env.DB, adapter.key, changedProducts, observedAt),
    );
    const quality = await stageRecorder.run("data_quality", { inputCount: items.size }, () =>
      safeSaveDataQuality(env, adapter, runId, observedAt, {
        parseAttemptCount,
        parseSuccessCount: Math.max(0, parseAttemptCount - parseFailureCount),
        parseFailureCount,
        evidenceExpectedEventCount: evidenceMetrics.expected,
        evidenceArchivedEventCount: evidenceMetrics.archived,
        evidenceArchiveFailureCount: evidenceMetrics.failed,
        previousItemCount: Number.isFinite(previousItemCount) ? previousItemCount : null,
        currentItemCount: items.size,
      }),
    );
    // Only once no stage still owes a chunk. Freeing the work set while one is pending would leave
    // the sweep a stage it could not read, and it would silently settle it as if it had run.
    if (!derived.pending) await clearCrawlRunWorkItems(env.DB, runId);
    await recordCrawlWorkloadObservation(env.DB, adapter.key, {
      itemCount: items.size,
      budgetExhausted: derived.deferred,
      observedAt,
    });
    await markShopSuccess(env.DB, adapter.key, observedAt, items.size);
    // The inventory watermark advances either way: the collection succeeded. The projection
    // watermark only advances when nothing is still owed, so a crawl that deferred its remaining
    // chunks or lost a stage reports fresh listings without claiming search has caught up.
    if (!derived.pending) await markShopProjectionComplete(env.DB, adapter.key, observedAt);
    const diagnosticParts = [];
    if (pageDiagnostic != null) diagnosticParts.push(`diag=${JSON.stringify(pageDiagnostic)}`);
    if (enrichment.detailRequests || enrichment.cacheHits || enrichment.unresolvedCount) {
      diagnosticParts.push(
        `category_enrichment=${JSON.stringify({
          detailRequests: enrichment.detailRequests,
          cacheHits: enrichment.cacheHits,
          enrichedCount: enrichment.enrichedCount,
          unresolvedCount: enrichment.unresolvedCount,
        })}`,
      );
    }
    if (derived.searchProjection.changedCount) {
      diagnosticParts.push(`search_projection=${JSON.stringify(derived.searchProjection)}`);
    }
    if (derived.searchEntities.entity_count || derived.searchEntities.removed_entity_count) {
      diagnosticParts.push(`search_entities=${JSON.stringify(derived.searchEntities)}`);
    }
    if (derived.membershipCleanup.listing_count) {
      diagnosticParts.push(`membership_cleanup=${JSON.stringify(derived.membershipCleanup)}`);
    }
    if (derived.pending) {
      diagnosticParts.push(derived.deferred ? "derived_work=deferred" : "derived_work=incomplete");
    }
    if (
      derived.identity.identity_resolution_write_count ||
      derived.identity.identity_unresolved_count ||
      derived.identity.identity_veto_count
    ) {
      diagnosticParts.push(`identity=${JSON.stringify(derived.identity)}`);
    }
    if (quality) diagnosticParts.push(`quality=${JSON.stringify({ status: quality.status })}`);
    // Stage durations are kept on the run row as well as in the logs: a stalled successor is
    // diagnosed against what the last completed run actually cost, and logs age out first.
    diagnosticParts.push(`stages=${JSON.stringify(stageRecorder.stageDurationsMs())}`);
    const diagnosticSuffix = diagnosticParts.length ? ` | ${diagnosticParts.join(" | ")}` : "";
    await finishCrawlRunSuccess(env.DB, runId, {
      finishedAt: observedAt,
      itemCount: items.size,
      pageCount,
      message: `${changedCount} changed, ${activityCount} activity, ${featureFactCount} feature facts, ${metadataChangedCount} metadata changed, ${touchedCount} touched, ${deactivatedCount} deactivated${diagnosticSuffix}`,
    });
    return {
      shopKey: adapter.key,
      status: "success",
      crawlRunId: runId,
      itemCount: items.size,
      pageCount,
      changedCount,
      activityCount,
      featureFactCount,
      metadataChangedCount,
      touchedCount,
      deactivatedCount,
      deactivateMissing: deactivateMissing === true,
      dataQuality: quality,
      searchProjection: derived.searchProjection,
      productIdentity: derived.identity,
      searchEntities: derived.searchEntities,
      categoryEnrichment: {
        detailRequests: enrichment.detailRequests,
        cacheHits: enrichment.cacheHits,
        enrichedCount: enrichment.enrichedCount,
        unresolvedCount: enrichment.unresolvedCount,
      },
    };
  } catch (error) {
    const crawlError: AugmentedCrawlError =
      error instanceof Error ? error : new Error(String(error));
    const failedAt = nowIso(new Date());
    // The stage the run was in when it threw. A run that never reached one failed during its own
    // setup, which is the case that previously escaped the boundary entirely.
    const failedStage = stages?.activeStage || null;
    console.warn(
      JSON.stringify({
        event: "crawl_failed",
        shopKey: adapter.key,
        crawlRunId: runId,
        failedStage,
        lastCompletedStage: stages?.lastCompletedStage || null,
        stageDurationsMs: stages?.stageDurationsMs() || {},
        message: crawlError.message,
      }),
    );
    evidenceMetrics.expected += 1;
    if (lastEvidenceHtml) {
      const evidence = await archiveEvidence({
        env,
        shopKey: adapter.key,
        crawlRunId: runId,
        reason: crawlError.evidenceReason || "crawl_validation_failure",
        html: lastEvidenceHtml,
        capturedAt: failedAt,
      });
      evidenceOutcome(evidenceMetrics, evidence);
    } else {
      evidenceMetrics.failed += 1;
    }
    const previousItemCount = Number(state?.last_item_count);
    const quality = await safeSaveDataQuality(env, adapter, runId, failedAt, {
      parseAttemptCount,
      parseSuccessCount: Math.max(0, parseAttemptCount - parseFailureCount),
      parseFailureCount,
      evidenceExpectedEventCount: evidenceMetrics.expected,
      evidenceArchivedEventCount: evidenceMetrics.archived,
      evidenceArchiveFailureCount: evidenceMetrics.failed,
      previousItemCount: Number.isFinite(previousItemCount) ? previousItemCount : null,
      currentItemCount: items.size,
    });
    await markShopFailure(
      env.DB,
      adapter.key,
      failedAt,
      crawlError.message,
      state?.consecutive_failures || 0,
    );
    if (runId !== null) {
      await finishCrawlRunFailure(env.DB, runId, {
        finishedAt: failedAt,
        pageCount,
        message: failedStage ? `${failedStage}: ${crawlError.message}` : crawlError.message,
      });
    }
    return {
      shopKey: adapter.key,
      status: "failed",
      crawlRunId: runId,
      error: crawlError.message,
      dataQuality: quality,
    };
  } finally {
    await transport?.close?.();
  }
}

export async function crawlDueShops(
  env: RuntimeEnv,
  options: CrawlShopOptions = {},
): Promise<CrawlResult[]> {
  const results: CrawlResult[] = [];
  for (const adapter of SHOP_PLUGINS) results.push(await crawlShop(env, adapter, options));
  return results;
}

export async function crawlNextDueShop(
  env: RuntimeEnv,
  { now = new Date(), fetchFn = fetch }: Pick<CrawlShopOptions, "now" | "fetchFn"> = {},
): Promise<CrawlResult> {
  const states = new Map((await listShopStates(env.DB)).map((row) => [row.shop_key, row]));
  const candidates = SHOP_PLUGINS.filter(
    (adapter) => getShopEnabled(env, adapter.definition) && isConfigured(env, adapter),
  )
    .map((adapter) => {
      const definition = adapter.definition;
      const interval = getShopIntervalMinutes(env, definition);
      const state = states.get(adapter.key);
      return {
        adapter,
        state,
        interval,
        due: isShopDue(state, interval, now),
        lastAttempt: state?.last_attempt_at || "",
      };
    })
    .filter((candidate) => candidate.due)
    .sort((a, b) => a.lastAttempt.localeCompare(b.lastAttempt));
  if (!candidates.length) return { status: "skipped", reason: "no_shop_due" };
  const next = candidates[0];
  if (!next) return { status: "skipped", reason: "no_shop_due" };
  return crawlShop(env, next.adapter, { now, fetchFn });
}
