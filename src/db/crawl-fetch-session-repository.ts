import type { CrawlPage } from "../crawler/types.js";
import type { QueryableDatabase, SqliteBool } from "./types.js";

export type CrawlFetchSessionStatus = "collecting" | "finalizing" | "completed" | "failed";
export type CrawlFetchPageState = "pending" | "fetched" | "parsed" | "ignored";
export type CrawlFetchContinuationPhase = "fetch" | "parse" | "finalize";

export interface CrawlFetchSessionRow {
  run_id: string;
  shop_key: string;
  requested_at: string;
  status: CrawlFetchSessionStatus;
  max_pages: number;
  page_limit: number;
  coverage_incomplete: SqliteBool;
  reached_end: SqliteBool;
  pages_fetched: number;
  pages_parsed: number;
  last_completed_page: string | null;
  continuation_sequence: number;
  next_phase: CrawlFetchContinuationPhase | null;
  next_page_key: string | null;
  finalization_claimed_at: string | null;
  final_crawl_run_id: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
}

export interface CrawlFetchPageRow {
  run_id: string;
  page_key: string;
  page_json: string;
  ordinal: number;
  state: CrawlFetchPageState;
  html_text: string | null;
  products_json: string | null;
  html_bytes: number;
  item_count: number;
  fetched_at: string | null;
  parsed_at: string | null;
}

export interface CrawlFetchPageInput {
  key: string;
  page: CrawlPage;
  ordinal: number;
}

function changes(result: D1Result<unknown> | null | undefined): number {
  return Number(result?.meta?.changes || 0);
}

export async function getCrawlFetchSession(
  db: QueryableDatabase,
  runId: string,
): Promise<CrawlFetchSessionRow | null> {
  return db.prepare("SELECT * FROM crawl_fetch_sessions WHERE run_id = ?").bind(runId).first<CrawlFetchSessionRow>();
}

export async function ensureCrawlFetchSession(
  db: QueryableDatabase,
  input: {
    runId: string;
    shopKey: string;
    requestedAt: string;
    maxPages: number;
    pageLimit: number;
    pages: readonly CrawlFetchPageInput[];
    createdAt: string;
  },
): Promise<{ session: CrawlFetchSessionRow; created: boolean }> {
  const first = input.pages[0] || null;
  const insert = await db.prepare(`
    INSERT INTO crawl_fetch_sessions (
      run_id, shop_key, requested_at, max_pages, page_limit,
      continuation_sequence, next_phase, next_page_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO NOTHING
  `).bind(
    input.runId,
    input.shopKey,
    input.requestedAt,
    input.maxPages,
    input.pageLimit,
    first ? "fetch" : "finalize",
    first?.key || null,
    input.createdAt,
    input.createdAt,
  ).run();
  const created = changes(insert) > 0;

  if (created && input.pages.length) {
    await db.batch(input.pages.map((page) => db.prepare(`
      INSERT OR IGNORE INTO crawl_fetch_pages
        (run_id, page_key, page_json, ordinal, state)
      VALUES (?, ?, ?, ?, 'pending')
    `).bind(input.runId, page.key, JSON.stringify(page.page), page.ordinal)));
  }

  const session = await getCrawlFetchSession(db, input.runId);
  if (!session) throw new Error(`crawl fetch session was not persisted: ${input.runId}`);
  if (session.shop_key !== input.shopKey || session.requested_at !== input.requestedAt) {
    throw new Error(`crawl fetch session identity mismatch: ${input.runId}`);
  }
  return { session, created };
}

export async function getCrawlFetchPage(
  db: QueryableDatabase,
  runId: string,
  pageKey: string,
): Promise<CrawlFetchPageRow | null> {
  return db.prepare("SELECT * FROM crawl_fetch_pages WHERE run_id = ? AND page_key = ?")
    .bind(runId, pageKey).first<CrawlFetchPageRow>();
}

export async function listCrawlFetchPages(
  db: QueryableDatabase,
  runId: string,
): Promise<CrawlFetchPageRow[]> {
  const result = await db.prepare(
    "SELECT * FROM crawl_fetch_pages WHERE run_id = ? ORDER BY ordinal ASC",
  ).bind(runId).all<CrawlFetchPageRow>();
  return result.results || [];
}

export function decodeCrawlFetchPage(row: Pick<CrawlFetchPageRow, "page_json">): CrawlPage {
  const value: unknown = JSON.parse(row.page_json);
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "url" in value && typeof (value as { url?: unknown }).url === "string") {
    return value as { url: string };
  }
  throw new Error("invalid staged crawl page");
}

export async function claimCrawlFetchFinalization(
  db: QueryableDatabase,
  runId: string,
  claimedAt: string,
  staleBefore: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE crawl_fetch_sessions
    SET status = 'finalizing', finalization_claimed_at = ?, updated_at = ?
    WHERE run_id = ? AND next_phase = 'finalize'
      AND (status = 'collecting' OR (status = 'finalizing' AND finalization_claimed_at <= ?))
  `).bind(claimedAt, claimedAt, runId, staleBefore).run();
  return changes(result) > 0;
}

export async function completeCrawlFetchSession(
  db: QueryableDatabase,
  input: { runId: string; finalizedAt: string; crawlRunId: number | null },
): Promise<void> {
  await db.prepare(`
    UPDATE crawl_fetch_sessions
    SET status = 'completed', final_crawl_run_id = ?, next_phase = NULL, next_page_key = NULL,
        finalized_at = ?, updated_at = ?, error_message = NULL
    WHERE run_id = ?
  `).bind(input.crawlRunId, input.finalizedAt, input.finalizedAt, input.runId).run();
}

export async function failCrawlFetchSession(
  db: QueryableDatabase,
  input: { runId: string; failedAt: string; message: string; crawlRunId?: number | null },
): Promise<void> {
  await db.prepare(`
    UPDATE crawl_fetch_sessions
    SET status = 'failed', final_crawl_run_id = COALESCE(?, final_crawl_run_id),
        next_phase = NULL, next_page_key = NULL, finalized_at = ?, updated_at = ?, error_message = ?
    WHERE run_id = ?
  `).bind(input.crawlRunId ?? null, input.failedAt, input.failedAt, input.message.slice(0, 1000), input.runId).run();
}
