export async function startCrawlRun(db, shopKey, startedAt) {
  const run = await db
    .prepare("INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, 'running')")
    .bind(shopKey, startedAt)
    .run();
  return run.meta.last_row_id;
}

export async function finishCrawlRunSuccess(
  db,
  runId,
  { finishedAt, itemCount, pageCount, message },
) {
  await db
    .prepare(
      "UPDATE crawl_runs SET finished_at = ?, status = 'success', item_count = ?, page_count = ?, message = ? WHERE id = ?",
    )
    .bind(finishedAt, itemCount, pageCount, message, runId)
    .run();
}

export async function finishCrawlRunFailure(db, runId, { finishedAt, pageCount, message }) {
  await db
    .prepare(
      "UPDATE crawl_runs SET finished_at = ?, status = 'failed', page_count = ?, message = ? WHERE id = ?",
    )
    .bind(finishedAt, pageCount, String(message).slice(0, 1000), runId)
    .run();
}
