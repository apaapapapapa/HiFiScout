import {
  CRAWL_STAGE_SCOPE,
  RESUMABLE_CRAWL_STAGES,
  advanceCrawlRunStage,
  claimCrawlRunWorkChunk,
  claimShopMembershipCleanupChunk,
  clearCrawlRunWorkItems,
  completeCrawlRunStage,
  ensureCrawlRunStages,
  hasNewerCrawlRun,
  listResumableCrawlRuns,
  nextPendingCrawlRunStage,
  recordCrawlRunStageFailure,
  supersedeCrawlRunStages,
  type CrawlRunStageCheckpoint,
  type ResumableCrawlRun,
  type ResumableCrawlStage,
} from "../db/crawl-run-continuation-repository.js";
import { syncProductIdentityResolutions } from "../db/product-identity-repository.js";
import { syncProductSearchEntities } from "../db/product-search-entity-repository.js";
import { syncProductSearchProjections } from "../db/product-search-projection-repository.js";
import { errorMessage } from "../types.js";
import type {
  IdentitySyncMetrics,
  ProductSearchEntitySyncResult,
  ProjectionSyncResult,
  QueryableDatabase,
} from "../db/types.js";

/** Listings per chunk. Small enough that one chunk is never the reason an invocation is killed. */
const DEFAULT_CHUNK_SIZE = 100;
/** Chunks one invocation may process before handing the rest to the next sweep. */
const DEFAULT_MAX_CHUNKS = 12;
/** Runs examined per sweep. The backlog drains over successive five-minute ticks. */
const DEFAULT_RUN_LIMIT = 3;

/**
 * Wall clock one invocation may spend on derived work.
 *
 * Deliberately far below Cloudflare's fifteen-minute Queue limit: an invocation killed at that
 * limit runs no catch or finally block, so the only way to leave a usable checkpoint behind is to
 * stop well before it. Every shop is measured against this, because the shop that needed it first
 * was the one classified as small.
 */
export const DERIVED_WORK_BUDGET_MS = 5 * 60_000;

/** Failure event names already documented for the stages that had their own. */
const STAGE_FAILURE_EVENTS: Readonly<Record<ResumableCrawlStage, string>> = Object.freeze({
  search_projection: "product_search_projection_sync_failure",
  identity_resolution: "product_identity_sync_failure",
  search_entity: "product_search_entity_sync_failure",
  membership_cleanup: "product_search_entity_cleanup_failure",
});

export function crawlStageScope(stage: ResumableCrawlStage): "run" | "shop" {
  return CRAWL_STAGE_SCOPE[stage];
}

export function crawlStageFailureEvent(stage: ResumableCrawlStage): string {
  return STAGE_FAILURE_EVENTS[stage];
}

/** What the derived stages produced, accumulated across every chunk they were driven in. */
export interface DerivedWorkMetrics {
  searchProjection: ProjectionSyncResult;
  identity: IdentitySyncMetrics;
  searchEntities: ProductSearchEntitySyncResult;
  membershipCleanup: ProductSearchEntitySyncResult;
}

export function emptyDerivedWorkMetrics(): DerivedWorkMetrics {
  return {
    searchProjection: { checkedCount: 0, changedCount: 0 },
    identity: {
      identity_exact_match_count: 0,
      identity_alias_match_count: 0,
      identity_fuzzy_match_count: 0,
      identity_unresolved_count: 0,
      identity_veto_count: 0,
      identity_resolution_write_count: 0,
    },
    searchEntities: { listing_count: 0, entity_count: 0, removed_entity_count: 0 },
    membershipCleanup: { listing_count: 0, entity_count: 0, removed_entity_count: 0 },
  };
}

function addEntityMetrics(
  target: ProductSearchEntitySyncResult,
  result: ProductSearchEntitySyncResult,
): number {
  target.listing_count += result.listing_count;
  target.entity_count += result.entity_count;
  target.removed_entity_count += result.removed_entity_count;
  return result.entity_count;
}

type StageRunner = (
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
  generation: string,
  metrics: DerivedWorkMetrics,
) => Promise<number>;

/**
 * How each resumable stage is driven for one chunk, returning the units it changed.
 *
 * Every runner is idempotent over its input: they compare against persisted state and skip
 * unchanged rows, which is what lets a chunk replay safely after an invocation dies between the
 * chunk's writes and its checkpoint.
 *
 * `search_entity` and `membership_cleanup` drive the same sync over different sets: this run's
 * changed listings, and the shop's listings that are gone but still hold an offer. Splitting them
 * is what keeps the cost of a chunk proportional to the chunk instead of to the shop.
 */
const STAGE_RUNNERS: Readonly<Record<ResumableCrawlStage, StageRunner>> = Object.freeze({
  async search_projection(db, shopKey, sourceIds, _generation, metrics) {
    const result = await syncProductSearchProjections(db, shopKey, sourceIds);
    metrics.searchProjection.checkedCount += result.checkedCount;
    metrics.searchProjection.changedCount += result.changedCount;
    return result.changedCount;
  },
  async identity_resolution(db, shopKey, sourceIds, generation, metrics) {
    const result = await syncProductIdentityResolutions(db, shopKey, sourceIds, generation);
    for (const key of Object.keys(metrics.identity) as (keyof IdentitySyncMetrics)[]) {
      metrics.identity[key] += result[key];
    }
    return result.identity_resolution_write_count;
  },
  async search_entity(db, shopKey, sourceIds, _generation, metrics) {
    return addEntityMetrics(
      metrics.searchEntities,
      await syncProductSearchEntities(db, shopKey, sourceIds),
    );
  },
  async membership_cleanup(db, shopKey, sourceIds, _generation, metrics) {
    return addEntityMetrics(
      metrics.membershipCleanup,
      await syncProductSearchEntities(db, shopKey, sourceIds),
    );
  },
});

async function claimStageChunk(
  db: QueryableDatabase,
  run: ResumableCrawlRun,
  checkpoint: CrawlRunStageCheckpoint,
  limit: number,
): Promise<string[]> {
  return CRAWL_STAGE_SCOPE[checkpoint.stage] === "shop"
    ? claimShopMembershipCleanupChunk(db, run.shopKey, checkpoint.afterSourceId, limit)
    : claimCrawlRunWorkChunk(db, run.crawlRunId, checkpoint.afterSourceId, limit);
}

export interface DrainCrawlRunStageOptions {
  chunkSize?: number;
  maxChunks?: number;
  /** Wall clock the whole drive may use, measured from {@link startedAtMs}. */
  budgetMs?: number;
  startedAtMs?: number;
  /** Accumulator shared across stages so one crawl reports one set of derived counters. */
  metrics?: DerivedWorkMetrics;
}

export interface CrawlStageDrainResult {
  stage: ResumableCrawlStage;
  /** False when the stage stopped on the chunk or time budget with work still to do. */
  completed: boolean;
  chunkCount: number;
  processedCount: number;
  changedCount: number;
}

function budgetSpent(startedAtMs: number, budgetMs: number | undefined): boolean {
  return budgetMs != null && Date.now() - startedAtMs >= budgetMs;
}

/**
 * Drives one stage in bounded chunks until it finishes, runs out of budget, or fails.
 *
 * This is the single runner: the crawl that owns the work and the cron sweep that inherits it call
 * exactly the same code, so a shop cannot be safe only because it happened to finish inline. A
 * failing chunk records its attempt and rethrows with the cursor unmoved, leaving the stage pending
 * for the next sweep to replay.
 */
export async function drainCrawlRunStage(
  db: QueryableDatabase,
  run: ResumableCrawlRun,
  checkpoint: CrawlRunStageCheckpoint,
  {
    chunkSize = DEFAULT_CHUNK_SIZE,
    maxChunks = DEFAULT_MAX_CHUNKS,
    budgetMs,
    startedAtMs = Date.now(),
    metrics = emptyDerivedWorkMetrics(),
  }: DrainCrawlRunStageOptions = {},
): Promise<CrawlStageDrainResult> {
  const result: CrawlStageDrainResult = {
    stage: checkpoint.stage,
    completed: false,
    chunkCount: 0,
    processedCount: 0,
    changedCount: 0,
  };
  let afterSourceId = checkpoint.afterSourceId;

  while (result.chunkCount < maxChunks && !budgetSpent(startedAtMs, budgetMs)) {
    const sourceIds = await claimStageChunk(db, run, { ...checkpoint, afterSourceId }, chunkSize);
    const at = new Date().toISOString();
    if (!sourceIds.length) {
      await completeCrawlRunStage(db, run.crawlRunId, checkpoint.stage, at);
      result.completed = true;
      return result;
    }

    try {
      result.changedCount += await STAGE_RUNNERS[checkpoint.stage](
        db,
        run.shopKey,
        sourceIds,
        run.generation,
        metrics,
      );
    } catch (error) {
      // The stage stays pending with its cursor unmoved, so the next sweep replays this chunk.
      await recordCrawlRunStageFailure(db, run.crawlRunId, checkpoint.stage, {
        message: errorMessage(error),
        at,
      });
      throw error;
    }

    // The cursor moves only after the chunk's own writes are durable.
    afterSourceId = sourceIds[sourceIds.length - 1] as string;
    await advanceCrawlRunStage(db, run.crawlRunId, checkpoint.stage, {
      afterSourceId,
      processedCount: sourceIds.length,
      at,
    });
    result.chunkCount += 1;
    result.processedCount += sourceIds.length;

    // A short chunk is the end of the work set, so the stage finishes here rather than spending a
    // whole extra pass to observe an empty tail.
    if (sourceIds.length < chunkSize) {
      await completeCrawlRunStage(db, run.crawlRunId, checkpoint.stage, at);
      result.completed = true;
      return result;
    }
  }
  return result;
}

export interface CrawlRunResumeResult {
  crawlRunId: number;
  shopKey: string;
  /** Stages finished by this invocation. */
  completedStages: ResumableCrawlStage[];
  chunkCount: number;
  processedCount: number;
  /** True when the run still owes work after this invocation. */
  hasMore: boolean;
  /** Set when a newer run for the shop retired this one's outstanding work. */
  superseded: boolean;
}

export interface ResumeCrawlRunOptions extends DrainCrawlRunStageOptions {
  now?: Date;
}

/**
 * Finishes one run's outstanding derived work, in dependency order, within a bounded budget.
 *
 * Stages run strictly by ordinal because which product a listing belongs to is decided by the
 * identity resolution written before it; resuming the entity refresh first would group this run's
 * listings against the previous run's identities.
 */
export async function resumeCrawlRun(
  db: QueryableDatabase,
  run: ResumableCrawlRun,
  { now = new Date(), startedAtMs = Date.now(), ...options }: ResumeCrawlRunOptions = {},
): Promise<CrawlRunResumeResult> {
  const result: CrawlRunResumeResult = {
    crawlRunId: run.crawlRunId,
    shopKey: run.shopKey,
    completedStages: [],
    chunkCount: 0,
    processedCount: 0,
    hasMore: false,
    superseded: false,
  };

  if (await hasNewerCrawlRun(db, run)) {
    await supersedeCrawlRunStages(db, run.crawlRunId, now.toISOString());
    await clearCrawlRunWorkItems(db, run.crawlRunId);
    result.superseded = true;
    console.warn(
      JSON.stringify({
        event: "crawl_run_continuation_superseded",
        shopKey: run.shopKey,
        crawlRunId: run.crawlRunId,
        generation: run.generation,
      }),
    );
    return result;
  }

  // A run recorded by an earlier deployment carries only the stages that existed then, so the
  // stages added since are created here before anything decides this run owes nothing.
  await ensureCrawlRunStages(db, run.crawlRunId, now.toISOString());

  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
  for (;;) {
    const checkpoint = await nextPendingCrawlRunStage(db, run.crawlRunId);
    if (!checkpoint) break;
    if (result.chunkCount >= maxChunks || budgetSpent(startedAtMs, options.budgetMs)) {
      result.hasMore = true;
      break;
    }

    let stageResult: CrawlStageDrainResult;
    try {
      stageResult = await drainCrawlRunStage(db, run, checkpoint, {
        ...options,
        startedAtMs,
        maxChunks: maxChunks - result.chunkCount,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "crawl_run_continuation_stage_failed",
          shopKey: run.shopKey,
          crawlRunId: run.crawlRunId,
          stage: checkpoint.stage,
          attempts: checkpoint.attempts + 1,
          message: errorMessage(error),
        }),
      );
      result.hasMore = true;
      return result;
    }

    result.chunkCount += stageResult.chunkCount;
    result.processedCount += stageResult.processedCount;
    if (stageResult.completed) {
      result.completedStages.push(checkpoint.stage);
      continue;
    }
    result.hasMore = true;
    break;
  }

  if (!result.hasMore) {
    // Every run-scoped stage walked the same work set, so it is only unreferenced once the last
    // stage has finished.
    await clearCrawlRunWorkItems(db, run.crawlRunId);
    console.log(
      JSON.stringify({
        event: "crawl_run_continuation_complete",
        shopKey: run.shopKey,
        crawlRunId: run.crawlRunId,
        completedStages: result.completedStages,
        chunkCount: result.chunkCount,
        processedCount: result.processedCount,
      }),
    );
  }
  return result;
}

export interface ResumeInterruptedCrawlRunsOptions extends ResumeCrawlRunOptions {
  runLimit?: number;
}

/**
 * Finishes the derived work of crawls that were interrupted before completing it.
 *
 * The sweep is the dispatch: pending work is durable in D1 before any of it is attempted, so there
 * is no window in which a run is owed a continuation that was never sent. It is also shop-agnostic
 * by construction — it reads the recorded stages, not the shop registry — so a new shop inherits
 * the same recovery by doing nothing. One budget covers the whole sweep, so a large backlog cannot
 * turn recovery itself into an invocation that gets killed.
 */
export async function resumeInterruptedCrawlRuns(
  db: QueryableDatabase,
  {
    runLimit = DEFAULT_RUN_LIMIT,
    budgetMs = DERIVED_WORK_BUDGET_MS,
    startedAtMs = Date.now(),
    ...options
  }: ResumeInterruptedCrawlRunsOptions = {},
): Promise<CrawlRunResumeResult[]> {
  const runs = await listResumableCrawlRuns(db, runLimit);
  const results: CrawlRunResumeResult[] = [];
  for (const run of runs) {
    results.push(await resumeCrawlRun(db, run, { ...options, budgetMs, startedAtMs }));
    if (budgetSpent(startedAtMs, budgetMs)) break;
  }
  return results;
}

export { RESUMABLE_CRAWL_STAGES };
