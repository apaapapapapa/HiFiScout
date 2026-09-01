import type { QueryableDatabase } from "../db/types.js";

const DAILY_QUEUE_WRITE_LIMIT = "exceeded the daily write operations limit in Queues free tier";

interface FailedReviewFinishedAtRow {
  finished_at: string | null;
}

export function isKnowledgeCatalogQueueDailyWriteLimit(message: string | null | undefined): boolean {
  return String(message || "")
    .toLowerCase()
    .includes(DAILY_QUEUE_WRITE_LIMIT.toLowerCase());
}

function utcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Cloudflare Queues free-tier write limits are daily. Re-dispatching a failed review again on the
 * same UTC day only burns more D1/Worker work and creates another failed review. Once the date has
 * rolled over, the normal bootstrap path may safely claim a recovery run again.
 */
export async function shouldDeferKnowledgeCatalogQueueQuotaRecovery(
  db: QueryableDatabase,
  failedRunId: number,
  message: string | null | undefined,
  now = new Date(),
): Promise<boolean> {
  if (!failedRunId || !isKnowledgeCatalogQueueDailyWriteLimit(message)) return false;
  const row = await db
    .prepare("SELECT finished_at FROM knowledge_catalog_review_runs WHERE id = ?")
    .bind(failedRunId)
    .first<FailedReviewFinishedAtRow>();
  if (!row?.finished_at) return false;
  const failedAt = new Date(row.finished_at);
  if (Number.isNaN(failedAt.getTime())) return false;
  return utcDateKey(failedAt) === utcDateKey(now);
}
