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
  // Resumable collection reserves its logical crawl row when finalization is claimed. Reusing that
  // row is what makes a hard-killed finalizer reopen the same run instead of creating a second run
  // and repeating downstream work under a new identity. Ordinary crawls have no matching active
  // fetch session and fall through to the historical INSERT below.
  const reserved = await db
    .prepare(`
      SELECT cr.id
      FROM crawl_runs cr
      JOIN crawl_fetch_sessions s ON s.run_id = cr.collection_run_id
      WHERE cr.shop_key = ?
        AND cr.status = 'running'
        AND s.status = 'finalizing'
        AND s.final_crawl_run_id IS NULL
      ORDER BY s.finalization_claimed_at DESC, cr.id DESC
      LIMIT 1
    `)
    .bind(shopKey)
    .first<{ id: number }>();
  if (reserved) return reserved.id;

  const run = await db
    .prepare("INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, 'running')")
    .bind(shopKey, startedAt)
    .run();
  return run.meta.last_row_id;
}

/**
 * Both terminal writes claim the run the way {@link finishCrawlRunInterrupted} does: the first
 * outcome to land wins and every later one is a no-op.
 *
 * This is not only about two recovery sweeps racing. A deadline-guarded write is not cancelled when
 * its caller stops waiting for it, so a terminal write that timed out can still arrive after the
 * crawl has recorded the opposite outcome. Without the claim, which of the two a run ends up
 * reporting would depend on how late the slow one happened to be.
 */
export async function finishCrawlRunSuccess(
  db: QueryableDatabase,
  runId: number,
  { finishedAt, itemCount, pageCount, message }: FinishCrawlRunSuccessInput,
): Promise<void> {
  await db
    .prepare(
      "UPDATE crawl_runs SET finished_at = ?, status = 'success', item_count = ?, page_count = ?, message = ? WHERE id = ? AND status = 'running'",
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
      "UPDATE crawl_runs SET finished_at = ?, status = 'failed', page_count = ?, message = ? WHERE id = ? AND status = 'running'",
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
