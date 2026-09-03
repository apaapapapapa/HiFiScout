import type { NormalizedCatalogProduct } from "../catalog/types.js";
import type { QueryableDatabase } from "./types.js";
import type { CrawlFetchPageInput, CrawlFetchPageRow } from "./crawl-fetch-session-repository.js";

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
    `)
      .bind(input.html, input.htmlBytes, input.fetchedAt, input.runId, input.pageKey),
    db
      .prepare(`
      UPDATE crawl_fetch_sessions
      SET pages_fetched = pages_fetched + 1,
          continuation_sequence = ?, next_phase = 'parse', next_page_key = ?, updated_at = ?
      WHERE run_id = ? AND status = 'collecting' AND continuation_sequence = ?
    `)
      .bind(nextSequence, input.pageKey, input.fetchedAt, input.runId, input.currentSequence),
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
    `)
      .bind(input.ignoredAt, input.runId, input.pageKey),
    db
      .prepare(`
      UPDATE crawl_fetch_sessions
      SET coverage_incomplete = 1, last_completed_page = ?, continuation_sequence = ?,
          next_phase = ?, next_page_key = ?, updated_at = ?
      WHERE run_id = ? AND status = 'collecting' AND continuation_sequence = ?
    `)
      .bind(
        input.pageKey,
        nextSequence,
        input.nextPageKey ? "fetch" : "finalize",
        input.nextPageKey,
        input.ignoredAt,
        input.runId,
        input.currentSequence,
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
  },
): Promise<void> {
  const nextSequence = input.currentSequence + 1;
  const statements = input.discoveredPages.map((page) =>
    db
      .prepare(`
    INSERT OR IGNORE INTO crawl_fetch_pages
      (run_id, page_key, page_json, ordinal, state)
    VALUES (?, ?, ?, ?, 'pending')
  `)
      .bind(input.runId, page.key, JSON.stringify(page.page), page.ordinal),
  );

  statements.push(
    db
      .prepare(`
    UPDATE crawl_fetch_pages
    SET state = 'parsed', products_json = ?, item_count = ?, html_text = NULL, parsed_at = ?
    WHERE run_id = ? AND page_key = ? AND state = 'fetched'
  `)
      .bind(
        JSON.stringify(input.products),
        input.products.length,
        input.parsedAt,
        input.runId,
        input.pageKey,
      ),
  );

  if (input.reachedEnd) {
    statements.push(
      db
        .prepare(`
      UPDATE crawl_fetch_pages SET state = 'ignored'
      WHERE run_id = ? AND state = 'pending'
    `)
        .bind(input.runId),
    );
  }

  statements.push(
    db
      .prepare(`
    UPDATE crawl_fetch_sessions
    SET pages_parsed = pages_parsed + 1,
        coverage_incomplete = CASE WHEN ? = 1 THEN 1 ELSE coverage_incomplete END,
        reached_end = CASE WHEN ? = 1 THEN 1 ELSE reached_end END,
        last_completed_page = ?, continuation_sequence = ?, next_phase = ?, next_page_key = ?, updated_at = ?
    WHERE run_id = ? AND status = 'collecting' AND continuation_sequence = ?
  `)
      .bind(
        input.coverageIncomplete ? 1 : 0,
        input.reachedEnd ? 1 : 0,
        input.pageKey,
        nextSequence,
        input.nextPageKey && !input.reachedEnd ? "fetch" : "finalize",
        input.reachedEnd ? null : input.nextPageKey,
        input.parsedAt,
        input.runId,
        input.currentSequence,
      ),
  );
  await db.batch(statements);
}

export async function stagedCrawlFetchItemCount(
  db: QueryableDatabase,
  runId: string,
): Promise<number> {
  const row = await db
    .prepare(`
    SELECT COALESCE(SUM(item_count), 0) AS item_count
    FROM crawl_fetch_pages WHERE run_id = ? AND state = 'parsed'
  `)
    .bind(runId)
    .first<{ item_count: number }>();
  return Number(row?.item_count || 0);
}

/**
 * Every listing this run has parsed, deduplicated by source id, in page order.
 *
 * The rows this needs are a minority of the run's staging table: `parsed` pages carrying a product
 * array. It used to reach them through the general `listCrawlFetchPages`, which is `SELECT *` over
 * every row of the run -- so the pending frontier, the fetched-but-unparsed pages and every staged
 * detail response came back too, each carrying the seller HTML that made it worth staging, and were
 * dropped by the loop below. On a shop staging tens of pages of HTML that is the largest read in
 * the phase, and none of it was ever used.
 *
 * So the filter moves into the query, which also narrows the columns to the one that is read.
 * `idx_crawl_fetch_pages_frontier` is `(run_id, state, ordinal)`, so the equality on state and the
 * ordering are both served by an index the schema already has -- no scan, no temporary sort, and no
 * new index for this.
 *
 * Page order is preserved because it decides the dedupe: a shop that re-lists the same source id on
 * a later page overwrites the earlier copy, and reordering the pages would silently change which
 * copy survives.
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

export function nextPendingPageKey(
  pages: readonly CrawlFetchPageRow[],
  excludingPageKey?: string,
): string | null {
  return (
    pages.find((page) => page.state === "pending" && page.page_key !== excludingPageKey)
      ?.page_key || null
  );
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
