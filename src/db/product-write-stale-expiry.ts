import { firstMeasured } from "./read-accounting.js";
/**
 * Stage A: age an unseen in-stock listing to unknown, never to sold or inactive.
 * Elapsed time is not sale evidence for partial/unknown-coverage shops. Stage B is owned by
 * inventory-recheck's repeated detail-page confirmation, independently of this stage's flag.
 */

import { decideInventoryState } from "../inventory/state.js";
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
const UNVOUCHED = `(last_confirmed_available_at IS NULL OR last_confirmed_available_at < ?)`;

type StaleRow = Pick<
  ProductRow,
  | "id"
  | "source_id"
  | "stock_status"
  | "last_seen_at"
  | "last_inventory_checked_at"
  | "last_confirmed_available_at"
  | "inventory_check_failures"
>;

/** Limit the index walk before filtering inventory evidence, including already-unknown rows. */
async function staleRows(db: QueryableDatabase, shopKey: string, before: string, limit: number) {
  const cursor = await firstMeasured<{ seenAt: string; id: number }>(
    db
      .prepare(`SELECT stale_inventory_cursor_seen_at AS seenAt,
    stale_inventory_cursor_id AS id FROM shop_sync_state WHERE shop_key = ?`)
      .bind(shopKey),
  );
  // Equality on last_seen_at makes the implicit rowid suffix seekable. A tuple inequality
  // alone rescans every row with the cursor timestamp in SQLite, so use two bounded seeks.
  const rows = await db
    .prepare(`WITH same_time AS MATERIALIZED (
      SELECT id, source_id, stock_status, last_seen_at, last_inventory_checked_at,
        last_confirmed_available_at, inventory_check_failures FROM products INDEXED BY ${LAST_SEEN_INDEX}
      WHERE shop_key = ? AND is_active = 1 AND last_seen_at = ? AND id > ? AND last_seen_at < ?
      ORDER BY id LIMIT ?
    ), later AS MATERIALIZED (
      SELECT id, source_id, stock_status, last_seen_at, last_inventory_checked_at,
        last_confirmed_available_at, inventory_check_failures FROM products INDEXED BY ${LAST_SEEN_INDEX}
      WHERE shop_key = ? AND is_active = 1 AND last_seen_at > ? AND last_seen_at < ?
      ORDER BY last_seen_at, id LIMIT MAX(0, ? - (SELECT COUNT(*) FROM same_time))
    ) SELECT * FROM same_time UNION ALL SELECT * FROM later`)
    .bind(
      shopKey,
      cursor?.seenAt ?? "",
      cursor?.id ?? 0,
      before,
      limit,
      shopKey,
      cursor?.seenAt ?? "",
      before,
      limit,
    )
    .all<StaleRow>();
  return { rows: rows.results ?? [], cursor };
}

/** Changes only stale in-stock listings; the current crawl's observations are protected. */
export async function expireStaleListings(
  db: QueryableDatabase,
  shopKey: string,
  { unknownBefore, limit }: StaleListingExpiry,
  observedSourceIds: ReadonlySet<string>,
  changedAt: string,
): Promise<StaleListingExpiryResult> {
  const batch = await staleRows(db, shopKey, unknownBefore, limit);
  const unknownSourceIds = batch.rows
    .filter(
      (row) =>
        !observedSourceIds.has(row.source_id) &&
        decideInventoryState({
          stockStatus: row.stock_status,
          lastSeenAt: row.last_seen_at,
          lastCheckedAt: row.last_inventory_checked_at,
          lastConfirmedAvailableAt: row.last_confirmed_available_at ?? null,
          failureCount: row.inventory_check_failures,
          latest: "not_checked",
          observedAt: changedAt,
          unknownBefore,
          failureThreshold: 2,
        }).action === "mark_unknown",
    )
    .map((row) => row.source_id);
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
             AND last_seen_at < ? AND ${UNVOUCHED}
             AND source_id IN (${chunk.map(() => "?").join(",")}) RETURNING source_id`,
        )
        .bind(changedAt, shopKey, unknownBefore, unknownBefore, ...chunk),
    );
  }
  const changed = statements.length ? await db.batch<{ source_id: string }>(statements) : [];
  const last = batch.rows.length === limit ? batch.rows.at(-1) : undefined;
  const nextSeen = last?.last_seen_at ?? "";
  const nextId = last?.id ?? 0;
  if (nextSeen !== (batch.cursor?.seenAt ?? "") || nextId !== (batch.cursor?.id ?? 0)) {
    await db
      .prepare(`INSERT INTO shop_sync_state(shop_key, stale_inventory_cursor_seen_at, stale_inventory_cursor_id)
      VALUES (?, ?, ?) ON CONFLICT(shop_key) DO UPDATE SET
      stale_inventory_cursor_seen_at = excluded.stale_inventory_cursor_seen_at,
      stale_inventory_cursor_id = excluded.stale_inventory_cursor_id`)
      .bind(shopKey, nextSeen, nextId)
      .run();
  }
  return {
    unknownSourceIds: changed.flatMap((result) => result.results ?? []).map((row) => row.source_id),
    deactivatedSourceIds: [],
  };
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
