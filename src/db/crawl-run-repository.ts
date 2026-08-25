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

export interface StalledCrawlRunRow {
  id: number;
  shop_key: string;
  started_at: string;
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
      SELECT id, shop_key, started_at
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
