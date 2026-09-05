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
import { accountReads, dbUsageMetrics, sumDbUsageMetrics } from "../db/read-accounting.js";
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
import { createInvocationDeadline, isDeadlineExceeded } from "../deadline.js";
import { archiveEvidence } from "../evidence/evidence-archive.js";
import { enrichProductCategories } from "./category-enricher.js";
import { createCrawlRunProgressRecorder } from "./crawl-progress.js";
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
  loadDetailEvidence?: import("./types.js").DetailEvidenceLoader;
  /** Staged publication has no seller HTML; its synthetic wrapper is never diagnostic evidence. */
  archiveSellerHtml?: boolean;
  /**
   * The instant category enrichment should evaluate its cache-age policy at, when some earlier
   * phase already evaluated it and this run has to reach the same answer.
   *
   * Separate from `now`, which drives scheduling and the recorded start time: a resumable crawl
   * finalizes minutes to hours after its Durable Object decided which detail pages to fetch, and
   * must not be told the crawl itself started back then. Defaults to the observation instant, which
   * is what a single-invocation crawl has always used.
   */
  enrichmentDecidedAt?: Date;
}

interface EvidenceMetrics {
  expected: number;
  archived: number;
  failed: number;
}

/**
 * Cost of one seller page, above which it is worth naming that page on its own.
 *
 * Sitting above every page cost observed in production and below the transport's own request
 * timeout, so it fires for a page that is pathologically slow rather than for a shop that is simply
 * the slowest of the healthy ones.
 */
const SLOW_PAGE_WARNING_MS = 20_000;

interface PageTimingSummary {
  pages: number;
  totalMs: number;
  slowestMs: number;
  slowestUrl: string;
}

interface PageTimings {
  record(shopKey: string, crawlRunId: number | null, url: string, durationMs: number): void;
  summary(): PageTimingSummary;
}

/**
 * What collection actually spent, per page.
 *
 * The collection budget has to be set against evidence rather than intuition, and the run summary
 * only ever carried the stage total — which cannot distinguish a shop with many quick pages from
 * one with a single page that nearly stalls. Individual pages are logged only when they cross
 * {@link SLOW_PAGE_WARNING_MS}, so the common case adds no log volume at all.
 */
function createPageTimings(): PageTimings {
  const summary: PageTimingSummary = { pages: 0, totalMs: 0, slowestMs: 0, slowestUrl: "" };
  return {
    record(shopKey, crawlRunId, url, durationMs) {
      summary.pages += 1;
      summary.totalMs += durationMs;
      if (durationMs > summary.slowestMs) {
        summary.slowestMs = durationMs;
        summary.slowestUrl = url;
      }
      if (durationMs >= SLOW_PAGE_WARNING_MS) {
        console.warn(
          JSON.stringify({ event: "crawl_page_slow", shopKey, crawlRunId, url, durationMs }),
        );
      }
    },
    summary: () => ({ ...summary }),
  };
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

/**
 * Archives one evidence snapshot without letting it decide the crawl's outcome.
 *
 * `archiveEvidence` already answers with a failed result rather than throwing, but the R2 put and
 * the D1 insert inside it are raw binding calls, and two of its three call sites sit between
 * recorded stages where nothing else would bound them. A stall in either would consume the
 * invocation exactly as an unguarded crawl did — which is the failure this whole change exists to
 * remove, so evidence must not be the one place it survives. It is diagnostics either way: a
 * snapshot that could not be stored is counted and moved past, never raised into the crawl.
 *
 * The bound is a slice of its own rather than the crawl's remaining budget. A guard waits until the
 * budget it was given is gone, so handing evidence the invocation budget would let one stalled
 * snapshot spend everything the listing write and the derived stages still needed.
 */
async function archiveCrawlEvidence(
  budgetMs: number,
  metrics: EvidenceMetrics,
  options: NonNullable<Parameters<typeof archiveEvidence>[0]>,
): Promise<void> {
  try {
    evidenceOutcome(
      metrics,
      await createInvocationDeadline(budgetMs).guard("crawl_evidence", () =>
        archiveEvidence(options),
      ),
    );
  } catch (error) {
    metrics.failed += 1;
    console.warn(
      JSON.stringify({
        event: "crawl_evidence_archive_failure",
        shopKey: options.shopKey,
        crawlRunId: options.crawlRunId ?? null,
        reason: options.reason ?? null,
        message: errorMessage(error),
      }),
    );
  }
}

/**
 * Runs one terminal write phase of a *successful* crawl, without letting it report a failed one.
 *
 * A guard cannot cancel the write it stopped waiting for. If a slow success write were raised into
 * the crawl's catch block, that block would record a failure and apply backoff, and the write still
 * in flight would then land `markShopSuccess` on top of it — leaving shop health contradicting the
 * run row, with which one won decided by how late the slow write happened to be. A stalled
 * bookkeeping write is also not a failed crawl in the first place: the listings are written and the
 * seller is done with. So the timeout is reported as what it is and the crawl keeps its outcome.
 *
 * Only the deadline is absorbed. A real error from the write itself still belongs to the crawl.
 */
async function recordCrawlSuccessPhase(
  budgetMs: number,
  phase: string,
  context: { shopKey: string; crawlRunId: number },
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await createInvocationDeadline(budgetMs).guard(phase, write);
  } catch (error) {
    if (!isDeadlineExceeded(error)) throw error;
    console.warn(
      JSON.stringify({
        event: "crawl_terminal_write_timeout",
        shopKey: context.shopKey,
        crawlRunId: context.crawlRunId,
        phase,
        message: errorMessage(error),
      }),
    );
  }
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
  {
    force = false,
    now = new Date(),
    fetchFn = fetch,
    enrichmentDecidedAt,
    loadDetailEvidence,
    archiveSellerHtml = true,
  }: CrawlShopOptions = {},
): Promise<CrawlResult> {
  const definition = adapter.definition;
  if (!getShopEnabled(env, definition))
    return { shopKey: adapter.key, status: "skipped", reason: "disabled" };
  if (!isConfigured(env, adapter))
    return { shopKey: adapter.key, status: "skipped", reason: "configuration_missing" };

  // The budgets are measured from here, not from the start of the derived work: what the platform
  // kills is the whole invocation, so reading shop state, fetch, parse and the derived stages all
  // have to count against the same clock. `getCrawlerSettings` is a pure read of `env`, so taking
  // it before the error boundary below costs nothing that the boundary exists to catch.
  const invocationStartedAtMs = Date.now();
  const settings = getCrawlerSettings(env);
  const deadline = createInvocationDeadline(settings.invocationBudgetMs, invocationStartedAtMs);
  const collectionDeadline = createInvocationDeadline(
    settings.collectionBudgetMs,
    invocationStartedAtMs,
  );

  const intervalMinutes = getShopIntervalMinutes(env, definition);
  const state = await deadline.guard("shop_state", () => getShopState(env.DB, adapter.key));
  if (!force && !isShopDue(state, intervalMinutes, now))
    return { shopKey: adapter.key, status: "skipped", reason: "not_due" };

  const startedAt = nowIso(now);
  const pageTimings = createPageTimings();
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
  await deadline.guard("shop_attempt", () => markShopAttempt(env.DB, adapter.key, startedAt));
  try {
    // The id is also held as a const because the deadline guards below close over it, and a `let`
    // that the catch block can still read keeps its nullable type inside a closure.
    const crawlRunId = await deadline.guard("crawl_run_start", () =>
      startCrawlRun(env.DB, adapter.key, startedAt),
    );
    runId = crawlRunId;
    const progress = createCrawlRunProgressRecorder(env.DB, runId, { deadline });
    const stageRecorder = createCrawlStageRecorder(adapter.key, runId, {
      deadline,
      onStageStart: (stage) => progress.record(stage),
    });
    stages = stageRecorder;
    const maxPages = getShopMaxPages(env, definition, settings.maxPagesPerShop);
    const pageLimit = maxPages + adapter.discovery.policy.extraPageBudget;
    const requestDelayMs = getShopRequestDelayMs(env, definition, settings.requestDelayMs);
    const robotsCache: RobotsCache = new Map();
    const activeTransport = createTransport(env, adapter.capabilities.transport?.kind, fetchFn);
    transport = activeTransport;
    const fetchParseStage = stageRecorder.begin("fetch_parse", { inputCount: pageLimit });
    await progress.record("fetch_parse", pageCount);
    const pageQueue = initialPageQueue(adapter, maxPages, env, { now, intervalMinutes, state });
    const queuedUrls = new Set(pageQueue.map((page) => targetUrl(adapter, page)));

    while (pageQueue.length && pageCount < pageLimit) {
      const page = pageQueue.shift();
      if (!page) break;
      const url = targetUrl(adapter, page);
      // Page count alone never bounded this loop in time: a page has been observed to cost anywhere
      // from 1 to 14 seconds, so a page budget that is safe for one seller is minutes of wall clock
      // for another. Stopping here makes an over-budget collection a failure that names the pages
      // it did fetch, instead of a kill at the platform limit that records nothing at all.
      collectionDeadline.check("collection");
      const pageStartedAtMs = Date.now();
      let html;
      try {
        html = await collectionDeadline.guard("seller_page", () =>
          activeTransport.fetchHtmlPage(url, {
            baseUrl: adapter.baseUrl,
            userAgent: settings.userAgent,
            requestDelayMs,
            fetchFn,
            robotsCache,
          }),
        );
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
      pageTimings.record(adapter.key, runId, url, Date.now() - pageStartedAtMs);
      await progress.record("fetch_parse", pageCount);
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
    const manufacturerAliasAccounting = accountReads(env.DB);
    const manufacturerResolvedProducts = await stageRecorder.run(
      "manufacturer_resolution",
      { inputCount: items.size },
      () =>
        resolveProductCatalogFields(manufacturerAliasAccounting.db, [...items.values()], {
          shopKey: adapter.key,
        }),
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
          loadDetailEvidence,
          transport: activeTransport,
          fetchOptions: {
            baseUrl: adapter.baseUrl,
            userAgent: settings.userAgent,
            requestDelayMs,
            fetchFn,
            robotsCache,
          },
          // Pinned by a resumable crawl to the instant its detail fetches were planned. The policy
          // is time-dependent -- an unresolved check expires and its listing becomes a target -- so
          // planning and finalization have to ask the same clock or finalization can require a
          // detail page the plan never staged.
          now: enrichmentDecidedAt ?? new Date(observedAt),
        }),
    );
    const categoryDbUsage = sumDbUsageMetrics(
      dbUsageMetrics(manufacturerAliasAccounting),
      enrichment.dbUsage,
    );
    console.log(
      JSON.stringify({
        event: "category_enrichment_db_usage",
        runId,
        shopKey: adapter.key,
        inputCount: manufacturerResolvedProducts.length,
        unresolvedCount: enrichment.unresolvedCount,
        detailRequestCount: enrichment.detailRequests,
        manufacturerAliasRowsRead: manufacturerAliasAccounting.rowsRead(),
        knowledgeCatalogRowsRead: enrichment.dbUsage.knowledgeCatalogRowsRead,
        manualAuthorityRowsRead: enrichment.dbUsage.manualAuthorityRowsRead,
        existingListingRowsRead: enrichment.dbUsage.existingListingRowsRead,
        ...categoryDbUsage,
      }),
    );
    const products = enrichment.products;
    logUnclassifiedProducts(adapter, products);

    if (archiveSellerHtml && enrichment.unresolvedCount > 0) {
      evidenceMetrics.expected += 1;
      if (classificationEvidenceHtml) {
        await archiveCrawlEvidence(settings.terminalBudgetMs, evidenceMetrics, {
          env,
          shopKey: adapter.key,
          crawlRunId,
          reason: "classification_unresolved",
          html: classificationEvidenceHtml,
          capturedAt: observedAt,
        });
      } else {
        evidenceMetrics.failed += 1;
      }
    }

    const previousItemCount = Number(state?.last_item_count);
    if (
      archiveSellerHtml &&
      Number.isFinite(previousItemCount) &&
      previousItemCount > 0 &&
      (items.size - previousItemCount) / previousItemCount <= -0.2
    ) {
      evidenceMetrics.expected += 1;
      await archiveCrawlEvidence(settings.terminalBudgetMs, evidenceMetrics, {
        env,
        shopKey: adapter.key,
        crawlRunId,
        reason: "unexpected_item_count",
        html: lastEvidenceHtml,
        capturedAt: observedAt,
      });
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
    await deadline.guard("crawl_run_work_set", () =>
      recordCrawlRunWorkSet(env.DB, {
        crawlRunId,
        generation: observedAt,
        sourceIds: derivedSourceIds,
        recordedAt: observedAt,
      }),
    );
    const derived = await syncDerivedProductState(env, adapter, observedAt, stageRecorder, runId, {
      workSetSize: derivedSourceIds.length,
      budgetMs: DERIVED_WORK_BUDGET_MS,
      startedAtMs: invocationStartedAtMs,
    });
    // Deliberately the whole observed set, not the derived delta. `listingChanged` never compares
    // `metadata_json`, so a change confined to metadata is invisible to that delta — and some are
    // only ever produced here, never recoverable later: `categoryClassification.detailCheckedAt` is
    // the negative cache for detail-page fetches, written exactly when the check did *not* classify
    // and therefore left every listing column alone. Dropping it would re-fetch that seller page on
    // every crawl. `syncProductMetadata` computes its own delta by comparing the stored JSON, so
    // this pass writes only what actually moved.
    const metadataChangedCount = await stageRecorder.run(
      "product_metadata",
      { inputCount: products.length, changedCount: (result) => result },
      () => syncProductMetadata(env.DB, adapter.key, products, observedAt),
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
    // The work budget is spent by the time a crawl reaches its outcome, so the writes that record
    // that outcome start a budget of their own. It is short because none of them is expensive: what
    // it bounds is a binding that stops answering, not a write that is merely slow.
    const outcomeContext = { shopKey: adapter.key, crawlRunId };
    await recordCrawlSuccessPhase(
      settings.terminalBudgetMs,
      "crawl_success_record",
      outcomeContext,
      async () => {
        // Only once no stage still owes a chunk. Freeing the work set while one is pending would
        // leave the sweep a stage it could not read, and it would silently settle it as if it had
        // run.
        if (!derived.pending) await clearCrawlRunWorkItems(env.DB, crawlRunId);
        await recordCrawlWorkloadObservation(env.DB, adapter.key, {
          itemCount: items.size,
          budgetExhausted: derived.deferred,
          observedAt,
        });
        await markShopSuccess(env.DB, adapter.key, observedAt, items.size);
        // The inventory watermark advances either way: the collection succeeded. The projection
        // watermark only advances when nothing is still owed, so a crawl that deferred its
        // remaining chunks or lost a stage reports fresh listings without claiming search has
        // caught up.
        if (!derived.pending) await markShopProjectionComplete(env.DB, adapter.key, observedAt);
      },
    );
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
    // diagnosed against what the last completed run actually cost, and logs age out first. Page
    // costs are kept for the same reason, and because they are what the collection budget has to be
    // set against: the stage total alone cannot separate many quick pages from one near-stall.
    diagnosticParts.push(`stages=${JSON.stringify(stageRecorder.stageDurationsMs())}`);
    diagnosticParts.push(`pages=${JSON.stringify(pageTimings.summary())}`);
    const diagnosticSuffix = diagnosticParts.length ? ` | ${diagnosticParts.join(" | ")}` : "";
    await recordCrawlSuccessPhase(
      settings.terminalBudgetMs,
      "crawl_run_finish",
      outcomeContext,
      () =>
        finishCrawlRunSuccess(env.DB, crawlRunId, {
          finishedAt: observedAt,
          itemCount: items.size,
          pageCount,
          message: `${changedCount} changed, ${activityCount} activity, ${featureFactCount} feature facts, ${metadataChangedCount} metadata changed, ${touchedCount} touched, ${deactivatedCount} deactivated${diagnosticSuffix}`,
        }),
    );
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
        pages: pageTimings.summary(),
        message: crawlError.message,
      }),
    );
    // Diagnostics run on budgets of their own, ahead of the terminal record and separate from it.
    // Evidence is an R2 write and quality is a D1 write, and either stalling used to take the whole
    // catch block with it — which is the shape that leaves a run with no outcome at all. Each is
    // bounded on its own, so neither can consume the time the record below needs.
    const qualityWrite = createInvocationDeadline(settings.terminalBudgetMs);
    if (archiveSellerHtml) {
      evidenceMetrics.expected += 1;
      if (lastEvidenceHtml) {
        await archiveCrawlEvidence(settings.terminalBudgetMs, evidenceMetrics, {
          env,
          shopKey: adapter.key,
          crawlRunId: runId,
          reason: crawlError.evidenceReason || "crawl_validation_failure",
          html: lastEvidenceHtml,
          capturedAt: failedAt,
        });
      } else {
        evidenceMetrics.failed += 1;
      }
    }
    const previousItemCount = Number(state?.last_item_count);
    const quality = await qualityWrite
      .guard("data_quality", () =>
        safeSaveDataQuality(env, adapter, runId, failedAt, {
          parseAttemptCount,
          parseSuccessCount: Math.max(0, parseAttemptCount - parseFailureCount),
          parseFailureCount,
          evidenceExpectedEventCount: evidenceMetrics.expected,
          evidenceArchivedEventCount: evidenceMetrics.archived,
          evidenceArchiveFailureCount: evidenceMetrics.failed,
          previousItemCount: Number.isFinite(previousItemCount) ? previousItemCount : null,
          currentItemCount: items.size,
        }),
      )
      .catch((qualityError: unknown) => {
        console.warn(
          JSON.stringify({
            event: "data_quality_evaluation_failure",
            shop: adapter.key,
            crawlRunId: runId,
            message: errorMessage(qualityError),
          }),
        );
        return null;
      });
    // Everything above this point is optional. This is not: without it the run stays `running` and
    // the shop stays silently busy, which is exactly the state the recovery sweep has to guess
    // about. It gets a fresh budget so a long crawl never arrives here with nothing left to spend.
    const failureWrites = createInvocationDeadline(settings.terminalBudgetMs);
    await failureWrites.guard("crawl_failure_record", async () => {
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
    });
    return {
      shopKey: adapter.key,
      status: "failed",
      crawlRunId: runId,
      error: crawlError.message,
      dataQuality: quality,
    };
  } finally {
    // A transport that will not close must not be able to discard an outcome the crawl already
    // recorded: this runs after both terminal paths, and an exception here would replace their
    // return value with a rejection the queue reads as a retry.
    const closeTransport = transport?.close?.bind(transport);
    if (closeTransport) {
      await createInvocationDeadline(settings.terminalBudgetMs)
        .guard("transport_close", () => closeTransport())
        .catch((closeError: unknown) => {
          console.warn(
            JSON.stringify({
              event: "crawl_transport_close_failure",
              shopKey: adapter.key,
              crawlRunId: runId,
              message: errorMessage(closeError),
            }),
          );
        });
    }
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
