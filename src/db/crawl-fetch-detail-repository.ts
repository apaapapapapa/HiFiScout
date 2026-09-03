import type { QueryableDatabase } from "./types.js";

const DETAIL_PAGE_KEY_PREFIX = "__hifiscout_category_detail__:";

export interface CrawlFetchDetailPageRow {
  run_id: string;
  target_url: string;
  html_text: string | null;
  error_message: string | null;
  html_bytes: number;
  fetched_at: string;
}

interface DetailStagingRow {
  html_text: string | null;
  products_json: string | null;
  html_bytes: number;
  fetched_at: string | null;
}

function detailPageKey(targetUrl: string): string {
  return `${DETAIL_PAGE_KEY_PREFIX}${targetUrl}`;
}

function stagedErrorMessage(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "errorMessage" in parsed &&
      typeof parsed.errorMessage === "string"
    ) {
      return parsed.errorMessage;
    }
  } catch {
    // Detail metadata is private staging state. Treat malformed legacy data as no staged error.
  }
  return null;
}

/**
 * Detail responses reuse the existing crawl_fetch_pages staging table. They are terminal `ignored`
 * rows with ordinals appended after the parsed listing frontier, so they cannot participate in page
 * discovery, item counts or the fetch/parse continuation state machine. This keeps Phase 5 schema
 * compatible with production databases that already have migration 0065 applied.
 */
export async function getCrawlFetchDetailPage(
  db: QueryableDatabase,
  runId: string,
  targetUrl: string,
): Promise<CrawlFetchDetailPageRow | null> {
  const staged = await db
    .prepare(`
      SELECT html_text, products_json, html_bytes, fetched_at
      FROM crawl_fetch_pages
      WHERE run_id = ? AND page_key = ? AND state = 'ignored'
    `)
    .bind(runId, detailPageKey(targetUrl))
    .first<DetailStagingRow>();
  if (!staged) return null;
  if (!staged.fetched_at) throw new Error(`invalid staged category detail fetch: ${targetUrl}`);
  return {
    run_id: runId,
    target_url: targetUrl,
    html_text: staged.html_text,
    error_message: stagedErrorMessage(staged.products_json),
    html_bytes: Number(staged.html_bytes || 0),
    fetched_at: staged.fetched_at,
  };
}

/**
 * Whether this run already committed a detail-fetch attempt for the target.
 *
 * The crash-recovery fence only ever asks *whether* a target was committed, and the answer is one
 * bit. {@link getCrawlFetchDetailPage} answers it by loading the staged detail page -- its HTML, its
 * metadata, its byte count -- which the fence then discards. Once per skipped target that is a
 * whole seller page serialised by D1, transferred to the isolate, and dropped; the plan cursor asks
 * it once per Alarm and once per target it recovers past.
 *
 * The `(run_id, page_key)` primary key answers this without visiting the row, so the cost is the
 * index seek and nothing else.
 *
 * Deliberately without the `fetched_at` validation the full read performs: a fence answers "already
 * attempted", and a row that exists but is malformed still means this run must not ask the seller
 * again. Finalization, which needs the response itself, keeps that check.
 */
export async function hasCrawlFetchDetailPage(
  db: QueryableDatabase,
  runId: string,
  targetUrl: string,
): Promise<boolean> {
  const staged = await db
    .prepare(`
      SELECT 1 AS committed
      FROM crawl_fetch_pages
      WHERE run_id = ? AND page_key = ? AND state = 'ignored'
      LIMIT 1
    `)
    .bind(runId, detailPageKey(targetUrl))
    .first<{ committed: number }>();
  return staged != null;
}

/**
 * Records one completed detail-fetch attempt in migration-0065 staging. The first terminal outcome
 * wins: Alarm redelivery or an infrastructure retry cannot turn one logical seller request into a
 * second unpaced request. Detail rows are appended only after the listing frontier reaches finalize.
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
  const pageKey = detailPageKey(input.targetUrl);
  const pageJson = JSON.stringify({ kind: "category_detail", targetUrl: input.targetUrl });
  const metadataJson = errorMessage ? JSON.stringify({ errorMessage }) : null;

  await db
    .prepare(`
      INSERT OR IGNORE INTO crawl_fetch_pages
        (run_id, page_key, page_json, ordinal, state, html_text, products_json,
         html_bytes, item_count, fetched_at, parsed_at)
      SELECT ?, ?, ?, COALESCE(MAX(ordinal), -1) + 1, 'ignored', ?, ?, ?, 0, ?, ?
      FROM crawl_fetch_pages
      WHERE run_id = ?
    `)
    .bind(
      input.runId,
      pageKey,
      pageJson,
      html,
      metadataJson,
      htmlBytes,
      input.fetchedAt,
      input.fetchedAt,
      input.runId,
    )
    .run();
}
