import {
  RESUMABLE_CRAWL_STAGES,
  advanceCrawlRunStage,
  claimCrawlRunWorkChunk,
  clearCrawlRunWorkItems,
  completeCrawlRunStage,
  hasNewerCrawlRun,
  listResumableCrawlRuns,
  nextPendingCrawlRunStage,
  recordCrawlRunStageFailure,
  supersedeCrawlRunStages,
  type ResumableCrawlRun,
  type ResumableCrawlStage,
} from "../db/crawl-run-continuation-repository.js";
import { syncProductIdentityResolutions } from "../db/product-identity-repository.js";
import { syncProductSearchEntities } from "../db/product-search-entity-repository.js";
import { syncProductSearchProjections } from "../db/product-search-projection-repository.js";
import { errorMessage } from "../types.js";
import type { QueryableDatabase } from "../db/types.js";

/** Listings per chunk. Small enough that one chunk is never the reason an invocation is killed. */
const DEFAULT_CHUNK_SIZE = 100;
/** Chunks one invocation may process before handing the rest to the next sweep. */
const DEFAULT_MAX_CHUNKS = 12;
/** Runs examined per sweep. The backlog drains over successive five-minute ticks. */
const DEFAULT_RUN_LIMIT = 3;

type StageRunner = (
  db: QueryableDatabase,
  shopKey: string,
  sourceIds: readonly string[],
  generation: string,
) => Promise<number>;

/**
 * How each resumable stage is driven for one chunk.
 *
 * Every runner is idempotent over its input: they compare against persisted state and skip
 * unchanged rows, which is what lets a chunk replay safely after an invocation dies between the
 * chunk's writes and its checkpoint.
 */
const STAGE_RUNNERS: Readonly<Record<ResumableCrawlStage, StageRunner>> = Object.freeze({
  async search_projection(db, shopKey, sourceIds) {
    return (await syncProductSearchProjections(db, shopKey, sourceIds)).changedCount;
  },
  async identity_resolution(db, shopKey, sourceIds, generation) {
    const metrics = await syncProductIdentityResolutions(db, shopKey, sourceIds, generation);
    return metrics.identity_resolution_write_count;
  },
  async search_entity(db, shopKey, sourceIds) {
    return (await syncProductSearchEntities(db, shopKey, sourceIds)).entity_count;
  },
});

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

export interface ResumeCrawlRunOptions {
  now?: Date;
  chunkSize?: number;
  maxChunks?: number;
  budgetMs?: number;
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
  {
    now = new Date(),
    chunkSize = DEFAULT_CHUNK_SIZE,
    maxChunks = DEFAULT_MAX_CHUNKS,
    budgetMs,
  }: ResumeCrawlRunOptions = {},
): Promise<CrawlRunResumeResult> {
  const startedAtMs = Date.now();
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

  for (;;) {
    const checkpoint = await nextPendingCrawlRunStage(db, run.crawlRunId);
    if (!checkpoint) break;
    if (result.chunkCount >= maxChunks) {
      result.hasMore = true;
      break;
    }
    if (budgetMs != null && Date.now() - startedAtMs >= budgetMs) {
      result.hasMore = true;
      break;
    }

    const sourceIds = await claimCrawlRunWorkChunk(
      db,
      run.crawlRunId,
      checkpoint.afterSourceId,
      chunkSize,
    );
    const finishedAt = new Date().toISOString();
    if (!sourceIds.length) {
      await completeCrawlRunStage(db, run.crawlRunId, checkpoint.stage, finishedAt);
      result.completedStages.push(checkpoint.stage);
      continue;
    }

    try {
      await STAGE_RUNNERS[checkpoint.stage](db, run.shopKey, sourceIds, run.generation);
    } catch (error) {
      // The stage stays pending with its cursor unmoved, so the next sweep replays this chunk.
      await recordCrawlRunStageFailure(db, run.crawlRunId, checkpoint.stage, {
        message: errorMessage(error),
        at: finishedAt,
      });
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

    // The cursor moves only after the chunk's own writes are durable.
    await advanceCrawlRunStage(db, run.crawlRunId, checkpoint.stage, {
      afterSourceId: sourceIds[sourceIds.length - 1] as string,
      processedCount: sourceIds.length,
      at: finishedAt,
    });
    result.chunkCount += 1;
    result.processedCount += sourceIds.length;

    // A short chunk is the end of the work set, so the stage finishes here rather than spending a
    // whole extra pass to observe an empty tail.
    if (sourceIds.length < chunkSize) {
      await completeCrawlRunStage(db, run.crawlRunId, checkpoint.stage, finishedAt);
      result.completedStages.push(checkpoint.stage);
    }
  }

  if (!result.hasMore) {
    // Every stage walked the same work set, so it is only unreferenced once the last one finished.
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
 * the same recovery by doing nothing.
 */
export async function resumeInterruptedCrawlRuns(
  db: QueryableDatabase,
  { runLimit = DEFAULT_RUN_LIMIT, ...options }: ResumeInterruptedCrawlRunsOptions = {},
): Promise<CrawlRunResumeResult[]> {
  const runs = await listResumableCrawlRuns(db, runLimit);
  const results: CrawlRunResumeResult[] = [];
  for (const run of runs) {
    results.push(await resumeCrawlRun(db, run, options));
  }
  return results;
}

export { RESUMABLE_CRAWL_STAGES };
