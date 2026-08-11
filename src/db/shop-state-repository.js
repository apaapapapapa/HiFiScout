export async function getShopState(db, shopKey) {
  return db.prepare('SELECT * FROM shop_sync_state WHERE shop_key = ?').bind(shopKey).first();
}

export async function listShopStates(db) {
  const result = await db.prepare('SELECT * FROM shop_sync_state').all();
  return result.results || [];
}

export async function markShopAttempt(db, shopKey, attemptedAt) {
  await db.prepare(`
    INSERT INTO shop_sync_state (shop_key, last_attempt_at) VALUES (?, ?)
    ON CONFLICT(shop_key) DO UPDATE SET last_attempt_at = excluded.last_attempt_at
  `).bind(shopKey, attemptedAt).run();
}

export async function markShopSuccess(db, shopKey, succeededAt, itemCount) {
  await db.prepare(`
    INSERT INTO shop_sync_state (shop_key, last_success_at, consecutive_failures, backoff_until, last_error, last_item_count)
    VALUES (?, ?, 0, NULL, NULL, ?)
    ON CONFLICT(shop_key) DO UPDATE SET last_success_at = excluded.last_success_at,
      consecutive_failures = 0, backoff_until = NULL, last_error = NULL, last_item_count = excluded.last_item_count
  `).bind(shopKey, succeededAt, itemCount).run();
}

export async function markShopFailure(db, shopKey, failedAt, message, priorFailures = 0) {
  const failures = priorFailures + 1;
  const backoffMinutes = Math.min(24 * 60, 15 * 2 ** Math.min(failures - 1, 6));
  const backoffUntil = new Date(new Date(failedAt).getTime() + backoffMinutes * 60_000).toISOString();
  await db.prepare(`
    INSERT INTO shop_sync_state (shop_key, last_error_at, consecutive_failures, backoff_until, last_error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_key) DO UPDATE SET last_error_at = excluded.last_error_at,
      consecutive_failures = excluded.consecutive_failures, backoff_until = excluded.backoff_until, last_error = excluded.last_error
  `).bind(shopKey, failedAt, failures, backoffUntil, String(message).slice(0, 1000)).run();
}

export async function markShopQueued(db, shopKey, queuedAt) {
  await db.prepare(`
    INSERT INTO shop_sync_state (shop_key, queued_at) VALUES (?, ?)
    ON CONFLICT(shop_key) DO UPDATE SET queued_at = excluded.queued_at
  `).bind(shopKey, queuedAt).run();
}

export async function clearShopQueued(db, shopKey) {
  await db.prepare('UPDATE shop_sync_state SET queued_at = NULL WHERE shop_key = ?').bind(shopKey).run();
}
