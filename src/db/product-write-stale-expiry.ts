/**
 * Stale-listing expiry for shops whose crawl cannot see their whole inventory.
 *
 * A complete-coverage crawl deactivates every listing it did not see. A partial one cannot: a
 * listing missing from a recent-arrivals feed may still be for sale. What it can prove is time. A
 * listing the crawl still sees is touched at least once per touch interval, so one left unseen far
 * beyond that, while the shop's crawls keep succeeding, is no longer on the pages the crawl reaches.
 * It is first downgraded to `unknown` (no longer advertised as in stock), then deactivated. Both
 * steps are reversed by the next sighting, which rewrites the listing from seller evidence.
 *
 * A detail recheck that recently found the listing available (or could not decide) is newer
 * evidence than its age, so it holds both steps until it is itself older than the horizon.
 */

import { deactivateProductsBySourceIds } from "./product-write-repository.js";
import type { ProductRow, QueryableDatabase } from "./types.js";

/** Partial (`is_active = 1`) index on `(shop_key, last_seen_at)`. */
const LAST_SEEN_INDEX = "idx_products_active_last_seen";
/** Bound parameters stay under D1's per-statement limit of 100. */
const UPDATE_CHUNK_SIZE = 50;

export interface StaleListingExpiry {
  /** In-stock listings last seen before this instant become `unknown`. */
  unknownBefore: string;
  /** Listings last seen before this instant are deactivated. */
  deactivateBefore: string;
  /** Upper bound on listings each step changes. */
  limit: number;
}

export interface StaleListingExpiryResult {
  unknownSourceIds: string[];
  deactivatedSourceIds: string[];
}

/** No detail recheck newer than `before` vouches for the listing. */
const UNVOUCHED = `(last_inventory_checked_at IS NULL OR last_inventory_checked_at < ?
  OR inventory_check_failures > 0)`;

async function staleSourceIds(
  db: QueryableDatabase,
  shopKey: string,
  before: string,
  limit: number,
  inStockOnly: boolean,
): Promise<string[]> {
  const result = await db
    .prepare(`
      SELECT source_id FROM products INDEXED BY ${LAST_SEEN_INDEX}
      WHERE shop_key = ? AND is_active = 1 AND last_seen_at < ?
        ${inStockOnly ? "AND stock_status = 'in_stock'" : ""}
        AND ${UNVOUCHED}
      ORDER BY last_seen_at ASC
      LIMIT ?`)
    .bind(shopKey, before, before, limit)
    .all<Pick<ProductRow, "source_id">>();
  return (result.results || []).map((row) => row.source_id);
}

/**
 * Applies both expiry steps to the shop's oldest-seen listings, never touching one observed by the
 * crawl that is running. Each step reads the active-listing `last_seen_at` index from its oldest
 * entry and stops at its limit, so the shop's recently seen inventory is never visited.
 */
export async function expireStaleListings(
  db: QueryableDatabase,
  shopKey: string,
  { unknownBefore, deactivateBefore, limit }: StaleListingExpiry,
  observedSourceIds: ReadonlySet<string>,
  changedAt: string,
): Promise<StaleListingExpiryResult> {
  const deactivatedSourceIds = (
    await staleSourceIds(db, shopKey, deactivateBefore, limit, false)
  ).filter((sourceId) => !observedSourceIds.has(sourceId));
  if (deactivatedSourceIds.length)
    await deactivateProductsBySourceIds(db, shopKey, deactivatedSourceIds);

  const unknownSourceIds = (await staleSourceIds(db, shopKey, unknownBefore, limit, true)).filter(
    (sourceId) => !observedSourceIds.has(sourceId),
  );
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < unknownSourceIds.length; index += UPDATE_CHUNK_SIZE) {
    const chunk = unknownSourceIds.slice(index, index + UPDATE_CHUNK_SIZE);
    // `+is_active` keeps the guard out of index selection, as deactivation does: the unique
    // (shop_key, source_id) key is the only index this update should read.
    statements.push(
      db
        .prepare(
          `UPDATE products SET stock_status = 'unknown', last_changed_at = ?
           WHERE shop_key = ? AND +is_active = 1 AND stock_status = 'in_stock'
             AND source_id IN (${chunk.map(() => "?").join(",")})`,
        )
        .bind(changedAt, shopKey, ...chunk),
    );
  }
  if (statements.length) await db.batch(statements);
  return { unknownSourceIds, deactivatedSourceIds };
}

/**
 * Whether the shop completed at least `minimum` successful crawls since `since`. Expiry reads a
 * listing's age as evidence only while the crawl has kept looking; an outage must not age the whole
 * inventory out. Reads at most the window's runs and stops at `minimum` successes.
 */
export async function hasRecentSuccessfulCrawls(
  db: QueryableDatabase,
  shopKey: string,
  since: string,
  minimum: number,
): Promise<boolean> {
  const row = await db
    .prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM crawl_runs
        WHERE shop_key = ? AND started_at >= ? AND status = 'success'
        LIMIT ?)`)
    .bind(shopKey, since, minimum)
    .first<{ count: number }>();
  return Number(row?.count ?? 0) >= minimum;
}
