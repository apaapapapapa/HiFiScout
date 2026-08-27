import type { QueryableDatabase } from "./types.js";

interface FinishCrawlRunSuccessInput {
  finishedAt: string;
  itemCount: number;
  pageCount: number;
  message: string;
}

interface FinishCrawlRunFailureInput {
  finishedAt: string;
  pageCount: number;
  message: unknown;
}

export async function startCrawlRun(
  db: QueryableDatabase,
  shopKey: string,
  startedAt: string,
): Promise<number> {
  const run = await db
    .prepare("INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, 'running')")
    .bind(shopKey, startedAt)
    .run();
  return run.meta.last_row_id;
}

export async function finishCrawlRunSuccess(
  db: QueryableDatabase,
  runId: number,
  { finishedAt, itemCount, pageCount, message }: FinishCrawlRunSuccessInput,
): Promise<void> {
  await db
    .prepare(
      "UPDATE crawl_runs SET finished_at = ?, status = 'success', item_count = ?, page_count = ?, message = ? WHERE id = ?",
    )
    .bind(finishedAt, itemCount, pageCount, message, runId)
    .run();
}

export async function finishCrawlRunFailure(
  db: QueryableDatabase,
  runId: number,
  { finishedAt, pageCount, message }: FinishCrawlRunFailureInput,
): Promise<void> {
  await db
    .prepare(
      "UPDATE crawl_runs SET finished_at = ?, status = 'failed', page_count = ?, message = ? WHERE id = ?",
    )
    .bind(finishedAt, pageCount, String(message).slice(0, 1000), runId)
    .run();
}

export interface CrawlRunProgressInput {
  /** The stage the run has entered, from the crawler's stage vocabulary. */
  stage: string;
  /** Seller pages finished so far. Zero for every stage after collection. */
  pagesDone: number;
  observedAt: string;
}

/**
 * Records how far a run has got, so a run that never reaches a terminal write can still say where
 * it stopped.
 *
 * The `status` predicate is what makes this safe to call from a deadline-guarded path: a guarded
 * call is not cancelled when the caller stops waiting for it, so a heartbeat can land after the run
 * has already been finished. Restricting the write to a `running` row means such a late arrival is
 * a no-op instead of reopening a settled run's progress fields.
 */
export async function recordCrawlRunProgress(
  db: QueryableDatabase,
  runId: number,
  { stage, pagesDone, observedAt }: CrawlRunProgressInput,
): Promise<void> {
  await db
    .prepare(`
      UPDATE crawl_runs
      SET current_stage = ?, pages_done = ?, last_progress_at = ?
      WHERE id = ? AND status = 'running'
    `)
    .bind(stage, pagesDone, observedAt, runId)
    .run();
}

export interface StalledCrawlRunRow {
  id: number;
  shop_key: string;
  started_at: string;
  /** Last stage the run reported entering; empty when it stopped before its first heartbeat. */
  current_stage: string;
  pages_done: number;
  last_progress_at: string | null;
}

/**
 * Runs still marked `running` after every consumer that could own them has expired.
 *
 * A Cloudflare invocation killed at its wall-clock limit runs no catch or finally block, so the row
 * it opened is never closed by the crawl itself. `startedBefore` must already account for the
 * execution lease: anything newer may still legitimately be executing.
 */
export async function listStalledCrawlRuns(
  db: QueryableDatabase,
  { startedBefore, limit }: { startedBefore: string; limit: number },
): Promise<StalledCrawlRunRow[]> {
  const result = await db
    .prepare(`
      SELECT id, shop_key, started_at, current_stage, pages_done, last_progress_at
      FROM crawl_runs
      WHERE status = 'running' AND started_at < ?
      ORDER BY started_at
      LIMIT ?
    `)
    .bind(startedBefore, limit)
    .all<StalledCrawlRunRow>();
  return result.results || [];
}

/**
 * Closes one abandoned run, and reports whether this caller is the one that closed it.
 *
 * The status predicate is the claim: a crawl that finished between the read and this write keeps
 * its own outcome, and two overlapping recovery sweeps cannot both record the same interruption.
 */
export async function finishCrawlRunInterrupted(
  db: QueryableDatabase,
  runId: number,
  { finishedAt, message }: { finishedAt: string; message: string },
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE crawl_runs
      SET finished_at = ?, status = 'failed', message = ?
      WHERE id = ? AND status = 'running'
    `)
    .bind(finishedAt, message.slice(0, 1000), runId)
    .run();
  return Number(result?.meta?.changes || 0) > 0;
}
