import type { QueryableDatabase } from "./types.js";

export interface CrawlFetchDetailPageRow {
  run_id: string;
  target_url: string;
  html_text: string | null;
  error_message: string | null;
  html_bytes: number;
  fetched_at: string;
}

export async function getCrawlFetchDetailPage(
  db: QueryableDatabase,
  runId: string,
  targetUrl: string,
): Promise<CrawlFetchDetailPageRow | null> {
  return db
    .prepare("SELECT * FROM crawl_fetch_detail_pages WHERE run_id = ? AND target_url = ?")
    .bind(runId, targetUrl)
    .first<CrawlFetchDetailPageRow>();
}

/**
 * Records one completed detail-fetch attempt. The first terminal outcome wins: Alarm redelivery or
 * an infrastructure retry cannot turn one logical seller request into a second unpaced request.
 */
export async function recordCrawlFetchDetailPage(
  db: QueryableDatabase,
  input: {
    runId: string;
    targetUrl: string;
    html?: string | null;
    errorMessage?: string | null;
    fetchedAt: string;
  },
): Promise<void> {
  const html = input.html ?? null;
  const errorMessage = input.errorMessage?.slice(0, 1000) || null;
  const htmlBytes = html == null ? 0 : new TextEncoder().encode(html).byteLength;
  await db
    .prepare(`
      INSERT INTO crawl_fetch_detail_pages
        (run_id, target_url, html_text, error_message, html_bytes, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, target_url) DO NOTHING
    `)
    .bind(input.runId, input.targetUrl, html, errorMessage, htmlBytes, input.fetchedAt)
    .run();
}
