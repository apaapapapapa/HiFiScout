import type { NormalizedCatalogProduct } from "../catalog/types.js";
import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase } from "./types.js";
import type { CrawlFetchPageInput, CrawlFetchPageRow } from "./crawl-fetch-session-repository.js";

const PAGE_KEY_LOOKUP_CHUNK_SIZE = 50;

export async function recordCrawlFetchPageFetched(
  db: QueryableDatabase,
  input: {
    runId: string;
    pageKey: string;
    html: string;
    htmlBytes: number;
    fetchedAt: string;
    currentSequence: number;
  },
): Promise<void> {
  const nextSequence = input.currentSequence + 1;
  await db.batch([
    db
      .prepare(`
        UPDATE crawl_fetch_pages
        SET state = 'fetched', html_text = ?, html_bytes = ?, fetched_at = ?
        WHERE run_id = ? AND page_key = ? AND state = 'pending'
          AND EXISTS (
            SELECT 1 FROM crawl_fetch_sessions s
            WHERE s.run_id = ? AND s.status = 'collecting'
              AND s.continuation_sequence = ? AND s.next_phase = 'fetch'
              AND s.next_page_key = ?
          )
      `)
      .bind(
        input.html,
        input.htmlBytes,
        input.fetchedAt,
        input.runId,
        input.pageKey,
        input.runId,
        input.currentSequence,
        input.pageKey,
      ),
    db
      .prepare(`
        UPDATE crawl_fetch_sessions
        SET pages_fetched = pages_fetched + 1,
            continuation_sequence = ?, next_phase = 'parse', next_page_key = ?, updated_at = ?
        WHERE run_id = ? AND status = 'collecting' AND continuation_sequence = ?
          AND next_phase = 'fetch' AND next_page_key = ?
          AND EXISTS (
            SELECT 1 FROM crawl_fetch_pages p
            WHERE p.run_id = crawl_fetch_sessions.run_id AND p.page_key = ?
              AND p.state = 'fetched' AND p.fetched_at = ?
          )
      `)
      .bind(
        nextSequence,
        input.pageKey,
        input.fetchedAt,
        input.runId,
        input.currentSequence,
        input.pageKey,
        input.pageKey,
        input.fetchedAt,
      ),
  ]);
}

export async function recordCrawlFetchPageIgnored(
  db: QueryableDatabase,
  input: {
    runId: string;
    pageKey: string;
    ignoredAt: string;
    currentSequence: number;
    nextPageKey: string | null;
  },
): Promise<void> {
  const nextSequence = input.currentSequence + 1;
  await db.batch([
    db
      .prepare(`
        UPDATE crawl_fetch_pages
        SET state = 'ignored', html_text = NULL, products_json = NULL, parsed_at = ?
        WHERE run_id = ? AND page_key = ? AND state = 'pending'
          AND EXISTS (
            SELECT 1 FROM crawl_fetch_sessions s
            WHERE s.run_id = ? AND s.status = 'collecting'
              AND s.continuation_sequence = ? AND s.next_phase = 'fetch'
              AND s.next_page_key = ?
          )
      `)
      .bind(
        input.ignoredAt,
        input.runId,
        input.pageKey,
        input.runId,
        input.currentSequence,
        input.pageKey,
      ),
    db
      .prepare(`
        UPDATE crawl_fetch_sessions
        SET coverage_incomplete = 1, last_completed_page = ?, continuation_sequence = ?,
            next_phase = ?, next_page_key = ?, updated_at = ?
        WHERE run_id = ? AND status = 'collecting' AND continuation_sequence = ?
          AND next_phase = 'fetch' AND next_page_key = ?
          AND EXISTS (
            SELECT 1 FROM crawl_fetch_pages p
            WHERE p.run_id = crawl_fetch_sessions.run_id AND p.page_key = ?
              AND p.state = 'ignored' AND p.parsed_at = ?
          )
      `)
      .bind(
        input.pageKey,
        nextSequence,
        input.nextPageKey ? "fetch" : "finalize",
        input.nextPageKey,
        input.ignoredAt,
        input.runId,
        input.currentSequence,
        input.pageKey,
        input.pageKey,
        input.ignoredAt,
      ),
  ]);
}

export async function recordCrawlFetchPageParsed(
  db: QueryableDatabase,
  input: {
    runId: string;
    pageKey: string;
    products: readonly NormalizedCatalogProduct[];
    discoveredPages: readonly CrawlFetchPageInput[];
    parsedAt: string;
    currentSequence: number;
    nextPageKey: string | null;
    coverageIncomplete: boolean;
    reachedEnd: boolean;
    /** Present only when the DO commits a freshly fetched page directly as parsed. */
    fetched?: { at: string; htmlBytes: number };
  },
): Promise<void> {
  const nextSequence = input.currentSequence + 1;
  const phase = input.fetched ? "fetch" : "parse";
  const state = input.fetched ? "pending" : "fetched";
  const statements = input.discoveredPages.map((page) =>
    db
      .prepare(`
        INSERT OR IGNORE INTO crawl_fetch_pages
          (run_id, page_key, page_json, ordinal, state)
        SELECT ?, ?, ?, ?, 'pending'
        WHERE EXISTS (
          SELECT 1 FROM crawl_fetch_sessions s
          WHERE s.run_id = ? AND s.status = 'collecting'
            AND s.continuation_sequence = ? AND s.next_phase = '${phase}'
            AND s.next_page_key = ?
        )
      `)
      .bind(
        input.runId,
        page.key,
        JSON.stringify(page.page),
        page.ordinal,
        input.runId,
        input.currentSequence,
        input.pageKey,
      ),
  );

  statements.push(
    db
      .prepare(`
        UPDATE crawl_fetch_pages
        SET state = 'parsed', products_json = ?, item_count = ?, html_text = NULL, parsed_at = ?,
            fetched_at = COALESCE(?, fetched_at), html_bytes = COALESCE(?, html_bytes)
        WHERE run_id = ? AND page_key = ? AND state = '${state}'
          AND EXISTS (
            SELECT 1 FROM crawl_fetch_sessions s
            WHERE s.run_id = ? AND s.status = 'collecting'
              AND s.continuation_sequence = ? AND s.next_phase = '${phase}'
              AND s.next_page_key = ?
          )
      `)
      .bind(
        JSON.stringify(input.products),
        input.products.length,
        input.parsedAt,
        input.fetched?.at ?? null,
        input.fetched?.htmlBytes ?? null,
        input.runId,
        input.pageKey,
        input.runId,
        input.currentSequence,
        input.pageKey,
      ),
  );

  if (input.reachedEnd) {
    statements.push(
      db
        .prepare(`
          UPDATE crawl_fetch_pages SET state = 'ignored'
          WHERE run_id = ? AND state = 'pending'
            AND EXISTS (
              SELECT 1 FROM crawl_fetch_sessions s
              WHERE s.run_id = ? AND s.status = 'collecting'
                AND s.continuation_sequence = ? AND s.next_phase = '${phase}'
                AND s.next_page_key = ?
            )
        `)
        .bind(input.runId, input.runId, input.currentSequence, input.pageKey),
    );
  }

  statements.push(
    db
      .prepare(`
        UPDATE crawl_fetch_sessions
        SET pages_parsed = pages_parsed + 1,
            pages_fetched = pages_fetched + ?,
            coverage_incomplete = CASE WHEN ? = 1 THEN 1 ELSE coverage_incomplete END,
            reached_end = CASE WHEN ? = 1 THEN 1 ELSE reached_end END,
            last_completed_page = ?, continuation_sequence = ?, next_phase = ?, next_page_key = ?, updated_at = ?
        WHERE run_id = ? AND status = 'collecting' AND continuation_sequence = ?
          AND next_phase = '${phase}' AND next_page_key = ?
          AND EXISTS (
            SELECT 1 FROM crawl_fetch_pages p
            WHERE p.run_id = crawl_fetch_sessions.run_id AND p.page_key = ?
              AND p.state = 'parsed' AND p.parsed_at = ?
          )
      `)
      .bind(
        input.fetched ? 1 : 0,
        input.coverageIncomplete ? 1 : 0,
        input.reachedEnd ? 1 : 0,
        input.pageKey,
        nextSequence,
        input.nextPageKey && !input.reachedEnd ? "fetch" : "finalize",
        input.reachedEnd ? null : input.nextPageKey,
        input.parsedAt,
        input.runId,
        input.currentSequence,
        input.pageKey,
        input.pageKey,
        input.parsedAt,
      ),
  );
  await db.batch(statements);
}

/**
 * Returns only discovered candidates that are already part of this run.
 *
 * Discovery is bounded by the plugin/page limit, so membership checks are candidate-sized rather
 * than frontier-sized. Keeping chunks below D1's bind-variable ceiling also makes the statement
 * count predictable even for a plugin that returns an unusually large candidate list.
 */
export async function knownCrawlFetchPageKeys(
  db: QueryableDatabase,
  runId: string,
  pageKeys: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(pageKeys.filter(Boolean))];
  const known = new Set<string>();
  for (let offset = 0; offset < unique.length; offset += PAGE_KEY_LOOKUP_CHUNK_SIZE) {
    const chunk = unique.slice(offset, offset + PAGE_KEY_LOOKUP_CHUNK_SIZE);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(`
        SELECT page_key
        FROM crawl_fetch_pages
        WHERE run_id = ? AND page_key IN (${placeholders})
      `)
      .bind(runId, ...chunk)
      .all<Pick<CrawlFetchPageRow, "page_key">>();
    for (const row of result.results || []) known.add(row.page_key);
  }
  return known;
}

/**
 * The three facts a page step needs about the rest of its run, in one bounded read.
 *
 * Each used to cost a materialization of the whole frontier, which is what made a P-page crawl
 * O(P^2). They are answered here by three index seeks instead:
 *
 * - `nextOrdinal` comes from `MAX(ordinal)` over `UNIQUE (run_id, ordinal)`, which is SQLite's
 *   MIN/MAX optimisation -- a seek to the last entry.
 * - `hasStagedItems` stops at the first parsed page carrying items, through
 *   `idx_crawl_fetch_pages_frontier`.
 * - `nextPendingPageKey` walks the same index in ordinal order and stops at the first pending page.
 *
 * Measured on the migrated schema, the whole statement is flat at ~3.5us from 100 to 100,000 pages
 * in the run.
 *
 * These come from `crawl_fetch_pages` rather than from aggregates cached on the session, and that
 * is the point rather than an implementation detail. D1 migrations are applied before the new
 * Worker ships, so a cached aggregate spends that gap being maintained by nobody: the old Worker
 * keeps adding pages, and the new Worker then trusts a stale `next_ordinal`, allocating an ordinal
 * an older Worker already used -- the discovered page is dropped by the uniqueness constraint while
 * the session advances to a page that does not exist. The pages table is the authority both Worker
 * versions maintain, so there is no window in which this can be stale, and no compatibility trigger
 * or per-run reconciliation to remove afterwards.
 */
export interface CrawlFetchFrontierProbe {
  /** The ordinal a newly discovered page should take. */
  nextOrdinal: number;
  /** Whether any page of this run has parsed at least one product. */
  hasStagedItems: boolean;
  /** The next page still waiting to be fetched, excluding the one being processed. */
  nextPendingPageKey: string | null;
}

interface FrontierProbeRow {
  next_ordinal: number | null;
  has_staged_items: number | null;
  next_pending_page_key: string | null;
}

export async function crawlFetchFrontierProbe(
  db: QueryableDatabase,
  runId: string,
  excludingPageKey = "",
): Promise<CrawlFetchFrontierProbe> {
  const row = await firstMeasured<FrontierProbeRow>(
    db
      .prepare(`
        SELECT
          COALESCE((
            SELECT MAX(ordinal) FROM crawl_fetch_pages WHERE run_id = ?
          ), -1) + 1 AS next_ordinal,
          EXISTS(
            SELECT 1 FROM crawl_fetch_pages
            WHERE run_id = ? AND state = 'parsed' AND item_count > 0
          ) AS has_staged_items,
          (
            SELECT page_key FROM crawl_fetch_pages
            WHERE run_id = ? AND state = 'pending' AND page_key <> ?
            ORDER BY ordinal ASC
            LIMIT 1
          ) AS next_pending_page_key
      `)
      .bind(runId, runId, runId, excludingPageKey),
  );
  return {
    nextOrdinal: Number(row?.next_ordinal || 0),
    hasStagedItems: Boolean(row?.has_staged_items),
    nextPendingPageKey: row?.next_pending_page_key || null,
  };
}

/**
 * Every listing this run has parsed, deduplicated by source id, in page order.
 *
 * This is the intentionally O(P) finalization read: it happens once per complete crawl rather than
 * once per page step. `idx_crawl_fetch_pages_frontier` is `(run_id, state, ordinal)`, so the filter
 * and ordering are served by the existing index without a temporary sort.
 */
export async function loadStagedCrawlProducts(
  db: QueryableDatabase,
  runId: string,
): Promise<NormalizedCatalogProduct[]> {
  const result = await db
    .prepare(`
      SELECT page_key, products_json
      FROM crawl_fetch_pages
      WHERE run_id = ? AND state = 'parsed' AND products_json IS NOT NULL
      ORDER BY ordinal ASC
    `)
    .bind(runId)
    .all<Pick<CrawlFetchPageRow, "page_key" | "products_json">>();
  const products = new Map<string, NormalizedCatalogProduct>();
  for (const row of result.results || []) {
    if (!row.products_json) continue;
    const parsed: unknown = JSON.parse(row.products_json);
    if (!Array.isArray(parsed)) throw new Error(`invalid staged products for ${row.page_key}`);
    for (const product of parsed as NormalizedCatalogProduct[]) {
      if (!product || typeof product.sourceId !== "string") continue;
      products.set(product.sourceId, product);
    }
  }
  return [...products.values()];
}

export async function setPublishedCrawlPageCount(
  db: QueryableDatabase,
  crawlRunId: number,
  pageCount: number,
): Promise<void> {
  await db
    .prepare("UPDATE crawl_runs SET page_count = ? WHERE id = ?")
    .bind(pageCount, crawlRunId)
    .run();
}
