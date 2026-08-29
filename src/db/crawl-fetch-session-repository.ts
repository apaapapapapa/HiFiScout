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

interface CollectionCrawlRunRow {
  id: number;
  status: "running" | "success" | "failed";
  message: string | null;
}

function changes(result: D1Result<unknown> | null | undefined): number {
  return Number(result?.meta?.changes || 0);
}

export async function getCrawlFetchSession(
  db: QueryableDatabase,
  runId: string,
): Promise<CrawlFetchSessionRow | null> {
  return db
    .prepare(`
      SELECT s.*
      FROM crawl_fetch_sessions s
      WHERE s.run_id = ?
        AND (
          s.status NOT IN ('collecting', 'finalizing')
          OR s.next_phase <> 'fetch'
          OR s.next_page_key IS NULL
          OR EXISTS (
            SELECT 1 FROM crawl_fetch_pages p WHERE p.run_id = s.run_id
          )
        )
    `)
    .bind(runId)
    .first<CrawlFetchSessionRow>();
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
  const insert = await db
    .prepare(`
      INSERT INTO crawl_fetch_sessions (
        run_id, shop_key, requested_at, max_pages, page_limit,
        continuation_sequence, next_phase, next_page_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `)
    .bind(
      input.runId,
      input.shopKey,
      input.requestedAt,
      input.maxPages,
      input.pageLimit,
      first ? "fetch" : "finalize",
      first?.key || null,
      input.createdAt,
      input.createdAt,
    )
    .run();
  const created = changes(insert) > 0;

  // Session creation and the frontier are intentionally repairable. If the isolate is killed after
  // the session row lands but before the frontier does, getCrawlFetchSession() hides that incomplete
  // active row from ensureSession(), which comes back through here and replays these idempotent
  // INSERTs. A normal duplicate delivery simply hits INSERT OR IGNORE and changes nothing.
  if (input.pages.length) {
    await db.batch(
      input.pages.map((page) =>
        db
          .prepare(`
            INSERT OR IGNORE INTO crawl_fetch_pages
              (run_id, page_key, page_json, ordinal, state)
            VALUES (?, ?, ?, ?, 'pending')
          `)
          .bind(input.runId, page.key, JSON.stringify(page.page), page.ordinal),
      ),
    );
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
  return db
    .prepare("SELECT * FROM crawl_fetch_pages WHERE run_id = ? AND page_key = ?")
    .bind(runId, pageKey)
    .first<CrawlFetchPageRow>();
}

export async function listCrawlFetchPages(
  db: QueryableDatabase,
  runId: string,
): Promise<CrawlFetchPageRow[]> {
  const result = await db
    .prepare("SELECT * FROM crawl_fetch_pages WHERE run_id = ? ORDER BY ordinal ASC")
    .bind(runId)
    .all<CrawlFetchPageRow>();
  return result.results || [];
}

export async function listActiveCrawlFetchSessions(
  db: QueryableDatabase,
): Promise<CrawlFetchSessionRow[]> {
  const result = await db
    .prepare(`
      SELECT * FROM crawl_fetch_sessions
      WHERE status IN ('collecting', 'finalizing')
      ORDER BY updated_at ASC
    `)
    .all<CrawlFetchSessionRow>();
  return result.results || [];
}

export async function deleteTerminalCrawlFetchSessions(
  db: QueryableDatabase,
  { finalizedBefore, limit }: { finalizedBefore: string; limit: number },
): Promise<number> {
  const result = await db
    .prepare(`
      DELETE FROM crawl_fetch_sessions
      WHERE run_id IN (
        SELECT run_id FROM crawl_fetch_sessions
        WHERE status IN ('completed', 'failed')
          AND finalized_at IS NOT NULL
          AND finalized_at < ?
        ORDER BY finalized_at ASC, run_id ASC
        LIMIT ?
      )
    `)
    .bind(finalizedBefore, limit)
    .run();
  return changes(result);
}

export function decodeCrawlFetchPage(row: Pick<CrawlFetchPageRow, "page_json">): CrawlPage {
  const value: unknown = JSON.parse(row.page_json);
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "url" in value &&
    typeof (value as { url?: unknown }).url === "string"
  ) {
    return value as { url: string };
  }
  throw new Error("invalid staged crawl page");
}

async function clearStagedPayloads(db: QueryableDatabase, runId: string): Promise<void> {
  await db
    .prepare(`
      UPDATE crawl_fetch_pages
      SET html_text = NULL, products_json = NULL
      WHERE run_id = ?
    `)
    .bind(runId)
    .run();
}

async function reconcileFinishedCollectionRun(
  db: QueryableDatabase,
  runId: string,
  observedAt: string,
): Promise<boolean> {
  const crawlRun = await db
    .prepare("SELECT id, status, message FROM crawl_runs WHERE collection_run_id = ?")
    .bind(runId)
    .first<CollectionCrawlRunRow>();
  if (!crawlRun || crawlRun.status === "running") return false;

  if (crawlRun.status === "success") {
    await completeCrawlFetchSession(db, {
      runId,
      finalizedAt: observedAt,
      crawlRunId: crawlRun.id,
    });
  } else {
    await failCrawlFetchSession(db, {
      runId,
      failedAt: observedAt,
      message: crawlRun.message || "crawl finalization failed",
      crawlRunId: crawlRun.id,
    });
  }
  return true;
}

export async function claimCrawlFetchFinalization(
  db: QueryableDatabase,
  runId: string,
  claimedAt: string,
  staleBefore: string,
): Promise<boolean> {
  // A hard kill may happen after crawlShop's terminal write but before the fetch-session terminal
  // write. In that case the crawl run is the durable source of truth and redelivery must reconcile
  // the session instead of running publish a second time.
  if (await reconcileFinishedCollectionRun(db, runId, claimedAt)) return false;

  const result = await db
    .prepare(`
      UPDATE crawl_fetch_sessions
      SET status = 'finalizing', finalization_claimed_at = ?, updated_at = ?
      WHERE run_id = ? AND next_phase = 'finalize'
        AND (status = 'collecting' OR (status = 'finalizing' AND finalization_claimed_at <= ?))
    `)
    .bind(claimedAt, claimedAt, runId, staleBefore)
    .run();
  if (changes(result) === 0) return false;

  // Reserve the logical crawl run before publish starts. startCrawlRun() reuses this row while its
  // collection session is finalizing, so a stale-finalizer reclaim cannot create a second run.
  await db
    .prepare(`
      INSERT INTO crawl_runs (shop_key, started_at, status, collection_run_id)
      SELECT shop_key, ?, 'running', run_id
      FROM crawl_fetch_sessions
      WHERE run_id = ?
      ON CONFLICT(collection_run_id) DO NOTHING
    `)
    .bind(claimedAt, runId)
    .run();
  return true;
}

export async function completeCrawlFetchSession(
  db: QueryableDatabase,
  input: { runId: string; finalizedAt: string; crawlRunId: number | null },
): Promise<void> {
  await db.batch([
    db
      .prepare(`
        UPDATE crawl_fetch_sessions
        SET status = 'completed', final_crawl_run_id = ?, next_phase = NULL, next_page_key = NULL,
            finalized_at = ?, updated_at = ?, error_message = NULL
        WHERE run_id = ?
      `)
      .bind(input.crawlRunId, input.finalizedAt, input.finalizedAt, input.runId),
    db
      .prepare(`
        UPDATE crawl_fetch_pages
        SET html_text = NULL, products_json = NULL
        WHERE run_id = ?
      `)
      .bind(input.runId),
  ]);
}

export async function failCrawlFetchSession(
  db: QueryableDatabase,
  input: { runId: string; failedAt: string; message: string; crawlRunId?: number | null },
): Promise<void> {
  await db.batch([
    db
      .prepare(`
        UPDATE crawl_fetch_sessions
        SET status = 'failed', final_crawl_run_id = COALESCE(?, final_crawl_run_id),
            next_phase = NULL, next_page_key = NULL, finalized_at = ?, updated_at = ?, error_message = ?
        WHERE run_id = ?
      `)
      .bind(
        input.crawlRunId ?? null,
        input.failedAt,
        input.failedAt,
        input.message.slice(0, 1000),
        input.runId,
      ),
    db
      .prepare(`
        UPDATE crawl_fetch_pages
        SET html_text = NULL, products_json = NULL
        WHERE run_id = ?
      `)
      .bind(input.runId),
  ]);
}
