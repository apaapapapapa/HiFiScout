import type { QueryableDatabase, ShopSyncStateRow } from "./types.js";

function changes(result: D1Result<unknown> | null | undefined): number {
  return Number(result?.meta?.changes || 0);
}

/** Stable identity for one crawl dispatch. */
export function crawlDispatchToken(shopKey: string, requestedAt: string): string {
  return `${shopKey}:${requestedAt}`;
}

export async function getShopState(
  db: QueryableDatabase,
  shopKey: string,
): Promise<ShopSyncStateRow | null> {
  return db
    .prepare("SELECT * FROM shop_sync_state WHERE shop_key = ?")
    .bind(shopKey)
    .first<ShopSyncStateRow>();
}

export async function listShopStates(db: QueryableDatabase): Promise<ShopSyncStateRow[]> {
  const result = await db.prepare("SELECT * FROM shop_sync_state").all<ShopSyncStateRow>();
  return result.results || [];
}

export async function markShopAttempt(
  db: QueryableDatabase,
  shopKey: string,
  attemptedAt: string,
): Promise<void> {
  await db
    .prepare(`
    INSERT INTO shop_sync_state (shop_key, last_attempt_at) VALUES (?, ?)
    ON CONFLICT(shop_key) DO UPDATE SET last_attempt_at = excluded.last_attempt_at
  `)
    .bind(shopKey, attemptedAt)
    .run();
}

export async function markShopSuccess(
  db: QueryableDatabase,
  shopKey: string,
  succeededAt: string,
  itemCount: number,
): Promise<void> {
  await db
    .prepare(`
    INSERT INTO shop_sync_state (shop_key, last_success_at, consecutive_failures, backoff_until, last_error, last_item_count)
    VALUES (?, ?, 0, NULL, NULL, ?)
    ON CONFLICT(shop_key) DO UPDATE SET last_success_at = excluded.last_success_at,
      consecutive_failures = 0, backoff_until = NULL, last_error = NULL, last_item_count = excluded.last_item_count
  `)
    .bind(shopKey, succeededAt, itemCount)
    .run();
}

/**
 * Records that a shop's derived work is complete as of this generation.
 *
 * Separate from {@link markShopSuccess} because the two answer different questions: a crawl can
 * collect a complete inventory and still owe projection chunks to the continuation sweep, which is
 * an ordinary outcome rather than a failure. Whoever finishes that work advances this — the crawl
 * when it drains its stages inline, the sweep when it finishes them later.
 *
 * The watermark only moves forward. The sweep can complete an older run after a newer crawl has
 * already reported, and letting that drag the watermark backwards would invent a regression.
 */
export async function markShopProjectionComplete(
  db: QueryableDatabase,
  shopKey: string,
  projectedAt: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE shop_sync_state
      SET last_projection_at = ?
      WHERE shop_key = ? AND (last_projection_at IS NULL OR last_projection_at < ?)
    `)
    .bind(projectedAt, shopKey, projectedAt)
    .run();
}

export async function markShopFailure(
  db: QueryableDatabase,
  shopKey: string,
  failedAt: string,
  message: unknown,
  priorFailures = 0,
): Promise<void> {
  const failures = priorFailures + 1;
  const backoffMinutes = Math.min(24 * 60, 15 * 2 ** Math.min(failures - 1, 6));
  const backoffUntil = new Date(
    new Date(failedAt).getTime() + backoffMinutes * 60_000,
  ).toISOString();
  await db
    .prepare(`
    INSERT INTO shop_sync_state (shop_key, last_error_at, consecutive_failures, backoff_until, last_error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_key) DO UPDATE SET last_error_at = excluded.last_error_at,
      consecutive_failures = excluded.consecutive_failures, backoff_until = excluded.backoff_until, last_error = excluded.last_error
  `)
    .bind(shopKey, failedAt, failures, backoffUntil, String(message).slice(0, 1000))
    .run();
}

/**
 * Atomically reserves one immutable crawl dispatch before handing it to the per-shop Durable Object.
 *
 * Time alone never replaces a reservation. Recovery re-delivers the same token to the same DO,
 * which keeps dispatch identity stable across Worker restarts and Alarm retries. `leaseMinutes`
 * remains in the signature because the setting now defines the recovery quiet period.
 */
export async function reserveShopDispatch(
  db: QueryableDatabase,
  shopKey: string,
  requestedAt: string,
  leaseMinutes: number,
): Promise<string | null> {
  void leaseMinutes;
  const dispatchToken = crawlDispatchToken(shopKey, requestedAt);
  const result = await db
    .prepare(`
      INSERT INTO shop_sync_state (
        shop_key,
        dispatch_requested_at,
        dispatch_token,
        dispatch_last_sent_at
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        dispatch_requested_at = excluded.dispatch_requested_at,
        dispatch_token = excluded.dispatch_token,
        dispatch_last_sent_at = excluded.dispatch_last_sent_at
      WHERE shop_sync_state.dispatch_requested_at IS NULL
    `)
    .bind(shopKey, requestedAt, dispatchToken, requestedAt)
    .run();
  return changes(result) > 0 ? dispatchToken : null;
}

/** Records a recovery delivery without changing the logical dispatch identity. */
export async function markShopDispatchSent(
  db: QueryableDatabase,
  shopKey: string,
  dispatchToken: string,
  sentAt: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE shop_sync_state
      SET dispatch_last_sent_at = ?
      WHERE shop_key = ? AND dispatch_token = ?
    `)
    .bind(sentAt, shopKey, dispatchToken)
    .run();
}

/** Releases only the dispatch reservation owned by this Durable Object execution. */
export async function releaseShopDispatch(
  db: QueryableDatabase,
  shopKey: string,
  dispatchToken: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE shop_sync_state
      SET dispatch_requested_at = NULL, dispatch_token = NULL, dispatch_last_sent_at = NULL
      WHERE shop_key = ? AND dispatch_token = ?
    `)
    .bind(shopKey, dispatchToken)
    .run();
}

/** Administrative clear for a dispatch that has been confirmed absent from Durable Object storage. */
export async function clearShopDispatch(db: QueryableDatabase, shopKey: string): Promise<void> {
  await db
    .prepare(`
      UPDATE shop_sync_state
      SET dispatch_requested_at = NULL, dispatch_token = NULL, dispatch_last_sent_at = NULL
      WHERE shop_key = ?
    `)
    .bind(shopKey)
    .run();
}
