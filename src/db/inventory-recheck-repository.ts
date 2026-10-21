import { firstMeasured } from "./read-accounting.js";
import type { InventoryRecheckCandidateRow, QueryableDatabase } from "./types.js";

interface InventoryCandidateWindow {
  staleBefore: string;
  retryBefore: string;
}

/** Partial (`is_active = 1`) index on `(shop_key, last_inventory_check_attempt_at, last_seen_at)`. */
const ATTEMPT_INDEX = "idx_products_inventory_recheck_attempt";
const RECHECKABLE_URL = "source_url LIKE 'https://www.audiounion.jp/ct/detail/used/%'";

/**
 * The shop's next listing to recheck: never-attempted listings first, then the oldest attempt;
 * ties fall to the oldest `last_seen_at`, then the lowest id.
 *
 * SQLite already sorts NULL attempts first, so that order is exactly the attempt index's own
 * `(attempt, last_seen_at, rowid)` order. It is read as two seeks rather than one walk because a
 * single walk would step over every recently seen never-attempted listing before reaching an
 * attempted one. The never-attempted seek is bounded by `last_seen_at`; the attempted one stops at
 * `retryBefore`, so listings checked within the retry interval are never visited. `COALESCE`
 * evaluates the second seek only when the first finds nothing.
 */
export async function selectInventoryRecheckCandidate(
  db: QueryableDatabase,
  shopKey: string,
  { staleBefore, retryBefore }: InventoryCandidateWindow,
): Promise<InventoryRecheckCandidateRow | null> {
  return firstMeasured<InventoryRecheckCandidateRow>(
    db
      .prepare(`
    SELECT id, source_id, source_url, last_seen_at, last_inventory_checked_at,
           last_inventory_check_attempt_at, inventory_check_failures
    FROM products
    WHERE id = COALESCE(
      (SELECT id FROM products INDEXED BY ${ATTEMPT_INDEX}
        WHERE shop_key = ?
          AND is_active = 1
          AND last_inventory_check_attempt_at IS NULL
          AND last_seen_at <= ?
          AND ${RECHECKABLE_URL}
        ORDER BY last_seen_at ASC, id ASC
        LIMIT 1),
      (SELECT id FROM products INDEXED BY ${ATTEMPT_INDEX}
        WHERE shop_key = ?
          AND is_active = 1
          AND last_inventory_check_attempt_at <= ?
          AND last_seen_at <= ?
          AND ${RECHECKABLE_URL}
        ORDER BY last_inventory_check_attempt_at ASC, last_seen_at ASC, id ASC
        LIMIT 1)
    )
  `)
      .bind(shopKey, staleBefore, shopKey, retryBefore, staleBefore),
  );
}

export async function markInventoryCheckAttempt(
  db: QueryableDatabase,
  productId: number,
  attemptedAt: string,
): Promise<D1Result> {
  return db
    .prepare(`
    UPDATE products
    SET last_inventory_check_attempt_at = ?
    WHERE id = ? AND is_active = 1
  `)
    .bind(attemptedAt, productId)
    .run();
}

export async function markInventoryAvailable(
  db: QueryableDatabase,
  productId: number,
  checkedAt: string,
): Promise<D1Result> {
  return db
    .prepare(`
    UPDATE products
    SET last_inventory_check_attempt_at = ?,
        last_inventory_checked_at = ?,
        inventory_check_failures = 0,
        last_changed_at = CASE WHEN stock_status <> 'in_stock' THEN ? ELSE last_changed_at END,
        stock_status = 'in_stock'
    WHERE id = ? AND is_active = 1
  `)
    .bind(checkedAt, checkedAt, checkedAt, productId)
    .run();
}

export async function markInventoryAmbiguous(
  db: QueryableDatabase,
  productId: number,
  checkedAt: string,
): Promise<D1Result> {
  return db
    .prepare(`
    UPDATE products
    SET last_inventory_check_attempt_at = ?,
        last_inventory_checked_at = ?,
        inventory_check_failures = 0
    WHERE id = ? AND is_active = 1
  `)
    .bind(checkedAt, checkedAt, productId)
    .run();
}

export async function recordInventoryUnavailable(
  db: QueryableDatabase,
  productId: number,
  checkedAt: string,
  failureCount: number,
  deactivate: boolean,
  evidence: "missing" | "sold" = "missing",
): Promise<D1Result> {
  const inactive = deactivate ? 1 : 0;
  const sold = deactivate || evidence === "sold" ? 1 : 0;
  return db
    .prepare(`
    UPDATE products
    SET last_inventory_check_attempt_at = ?,
        last_inventory_checked_at = ?,
        inventory_check_failures = ?,
        stock_status = CASE WHEN ? = 1 THEN 'sold_out' ELSE stock_status END,
        is_active = CASE WHEN ? = 1 THEN 0 ELSE is_active END,
        last_changed_at = CASE WHEN ? = 1 OR (? = 1 AND stock_status <> 'sold_out') THEN ? ELSE last_changed_at END
    WHERE id = ? AND is_active = 1
  `)
    .bind(checkedAt, checkedAt, failureCount, sold, inactive, inactive, sold, checkedAt, productId)
    .run();
}
