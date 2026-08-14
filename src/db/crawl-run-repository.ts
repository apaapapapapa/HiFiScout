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
