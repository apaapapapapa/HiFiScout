/**
 * Stage A: age an unseen in-stock listing to unknown, never to sold or inactive.
 * Elapsed time is not sale evidence for partial/unknown-coverage shops. Stage B is owned by
 * inventory-recheck's repeated detail-page confirmation, independently of this stage's flag.
 */

import type { ProductRow, QueryableDatabase } from "./types.js";

/** Partial (`is_active = 1`) index on `(shop_key, last_seen_at)`. */
const LAST_SEEN_INDEX = "idx_products_active_last_seen";
/** Bound parameters stay under D1's per-statement limit of 100. */
const UPDATE_CHUNK_SIZE = 50;

export interface StaleListingExpiry {
  /** In-stock listings last seen before this instant become `unknown`. */
  unknownBefore: string;
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
): Promise<string[]> {
  const result = await db
    .prepare(`
      SELECT source_id FROM products INDEXED BY ${LAST_SEEN_INDEX}
      WHERE shop_key = ? AND is_active = 1 AND last_seen_at < ?
        AND stock_status = 'in_stock'
        AND ${UNVOUCHED}
      ORDER BY last_seen_at ASC
      LIMIT ?`)
    .bind(shopKey, before, before, limit)
    .all<Pick<ProductRow, "source_id">>();
  return (result.results || []).map((row) => row.source_id);
}

/** Changes only stale in-stock listings; the current crawl's observations are protected. */
export async function expireStaleListings(
  db: QueryableDatabase,
  shopKey: string,
  { unknownBefore, limit }: StaleListingExpiry,
  observedSourceIds: ReadonlySet<string>,
  changedAt: string,
): Promise<StaleListingExpiryResult> {
  const unknownSourceIds = (await staleSourceIds(db, shopKey, unknownBefore, limit)).filter(
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
  return { unknownSourceIds, deactivatedSourceIds: [] };
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
