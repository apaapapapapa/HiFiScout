export async function selectInventoryRecheckCandidate(db, shopKey, { staleBefore, retryBefore }) {
  return db.prepare(`
    SELECT id, source_id, source_url, last_seen_at, last_inventory_checked_at,
           last_inventory_check_attempt_at, inventory_check_failures
    FROM products
    WHERE shop_key = ?
      AND is_active = 1
      AND last_seen_at <= ?
      AND (last_inventory_check_attempt_at IS NULL OR last_inventory_check_attempt_at <= ?)
      AND source_url LIKE 'https://www.audiounion.jp/ct/detail/used/%'
    ORDER BY
      CASE WHEN last_inventory_check_attempt_at IS NULL THEN 0 ELSE 1 END,
      last_inventory_check_attempt_at ASC,
      last_seen_at ASC,
      id ASC
    LIMIT 1
  `).bind(shopKey, staleBefore, retryBefore).first();
}

export async function markInventoryCheckAttempt(db, productId, attemptedAt) {
  return db.prepare(`
    UPDATE products
    SET last_inventory_check_attempt_at = ?
    WHERE id = ? AND is_active = 1
  `).bind(attemptedAt, productId).run();
}

export async function markInventoryAvailable(db, productId, checkedAt) {
  return db.prepare(`
    UPDATE products
    SET last_inventory_check_attempt_at = ?,
        last_inventory_checked_at = ?,
        inventory_check_failures = 0,
        last_changed_at = CASE WHEN stock_status <> 'in_stock' THEN ? ELSE last_changed_at END,
        stock_status = 'in_stock'
    WHERE id = ? AND is_active = 1
  `).bind(checkedAt, checkedAt, checkedAt, productId).run();
}

export async function markInventoryAmbiguous(db, productId, checkedAt) {
  return db.prepare(`
    UPDATE products
    SET last_inventory_check_attempt_at = ?,
        last_inventory_checked_at = ?,
        inventory_check_failures = 0
    WHERE id = ? AND is_active = 1
  `).bind(checkedAt, checkedAt, productId).run();
}

export async function markInventorySoldOut(db, productId, checkedAt) {
  return db.prepare(`
    UPDATE products
    SET last_inventory_check_attempt_at = ?,
        last_inventory_checked_at = ?,
        inventory_check_failures = 0,
        stock_status = 'sold_out',
        is_active = 0,
        last_changed_at = ?
    WHERE id = ? AND is_active = 1
  `).bind(checkedAt, checkedAt, checkedAt, productId).run();
}

export async function recordInventoryMissing(db, productId, checkedAt, failureCount, deactivate) {
  const inactive = deactivate ? 1 : 0;
  return db.prepare(`
    UPDATE products
    SET last_inventory_check_attempt_at = ?,
        last_inventory_checked_at = ?,
        inventory_check_failures = ?,
        stock_status = CASE WHEN ? = 1 THEN 'sold_out' ELSE stock_status END,
        is_active = CASE WHEN ? = 1 THEN 0 ELSE is_active END,
        last_changed_at = CASE WHEN ? = 1 THEN ? ELSE last_changed_at END
    WHERE id = ? AND is_active = 1
  `).bind(
    checkedAt,
    checkedAt,
    failureCount,
    inactive,
    inactive,
    inactive,
    checkedAt,
    productId
  ).run();
}
