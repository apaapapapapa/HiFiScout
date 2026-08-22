import type { QueryableDatabase, ShopSyncStateRow } from "./types.js";

function changes(result: D1Result<unknown> | null | undefined): number {
  return Number(result?.meta?.changes || 0);
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + Math.max(1, minutes) * 60_000).toISOString();
}

/** Stable identity for one dispatch. Queue messages already carry both components. */
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
 * Atomically reserves one shop before its child message is sent.
 *
 * A queued reservation is deliberately not time-expired here. Replacing an old token while its
 * message is still waiting moves that shop to the tail of the queue and can starve it indefinitely.
 * The scheduler may re-send the *same* stable child after a quiet recovery window, while Queue
 * retry/DLQ handling still owns normal delivery recovery. `leaseMinutes` remains in the signature
 * for rollout compatibility with callers/config and is intentionally ignored here.
 */
export async function reserveShopDispatch(
  db: QueryableDatabase,
  shopKey: string,
  queuedAt: string,
  leaseMinutes: number,
): Promise<string | null> {
  void leaseMinutes;
  const dispatchToken = crawlDispatchToken(shopKey, queuedAt);
  const result = await db
    .prepare(`
      INSERT INTO shop_sync_state (shop_key, queued_at, queued_token, queued_last_sent_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        queued_at = excluded.queued_at,
        queued_token = excluded.queued_token,
        queued_last_sent_at = excluded.queued_last_sent_at
      WHERE shop_sync_state.queued_at IS NULL
        AND (shop_sync_state.crawl_lease_until IS NULL OR shop_sync_state.crawl_lease_until <= ?)
    `)
    .bind(shopKey, queuedAt, dispatchToken, queuedAt, queuedAt)
    .run();
  return changes(result) > 0 ? dispatchToken : null;
}

/**
 * Records that the same logical child was handed to Queue again.
 *
 * Compare-and-update keeps a late recovery send from touching a newer reservation. The legacy
 * predicate covers queue messages that were created before queued_token existed.
 */
export async function markShopDispatchSent(
  db: QueryableDatabase,
  shopKey: string,
  dispatchToken: string,
  sentAt: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE shop_sync_state
      SET queued_last_sent_at = ?
      WHERE shop_key = ?
        AND (
          queued_token = ?
          OR (queued_token IS NULL AND ? = shop_key || ':' || queued_at)
        )
    `)
    .bind(sentAt, shopKey, dispatchToken, dispatchToken)
    .run();
}

/** Releases only the dispatch reservation owned by this message. */
export async function releaseShopDispatch(
  db: QueryableDatabase,
  shopKey: string,
  dispatchToken: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE shop_sync_state
      SET queued_at = NULL, queued_token = NULL, queued_last_sent_at = NULL
      WHERE shop_key = ?
        AND (
          queued_token = ?
          OR (queued_token IS NULL AND ? = shop_key || ':' || queued_at)
        )
    `)
    .bind(shopKey, dispatchToken, dispatchToken)
    .run();
}

/**
 * Atomically claims execution for a queued shop.
 *
 * Queue consumers have a 15-minute wall-clock limit. Callers use a lease longer than that limit,
 * so two live consumer invocations cannot crawl the same shop concurrently. The dispatch-token
 * predicate also rejects stale queue deliveries after the owning child job has completed.
 */
export async function tryClaimShopCrawl(
  db: QueryableDatabase,
  shopKey: string,
  requestedAt: string,
  claimedAt: string,
  leaseMinutes: number,
): Promise<string | null> {
  const dispatchToken = crawlDispatchToken(shopKey, requestedAt);
  const crawlLeaseToken = `${dispatchToken}:${crypto.randomUUID()}`;
  const leaseUntil = addMinutes(claimedAt, leaseMinutes);
  const result = await db
    .prepare(`
      INSERT INTO shop_sync_state (shop_key, crawl_lease_token, crawl_lease_until)
      VALUES (?, ?, ?)
      ON CONFLICT(shop_key) DO UPDATE SET
        crawl_lease_token = excluded.crawl_lease_token,
        crawl_lease_until = excluded.crawl_lease_until
      WHERE (shop_sync_state.crawl_lease_until IS NULL OR shop_sync_state.crawl_lease_until <= ?)
        AND (
          shop_sync_state.queued_token = ?
          OR (shop_sync_state.queued_token IS NULL AND shop_sync_state.queued_at = ?)
        )
    `)
    .bind(shopKey, crawlLeaseToken, leaseUntil, claimedAt, dispatchToken, requestedAt)
    .run();
  return changes(result) > 0 ? crawlLeaseToken : null;
}

/**
 * Releases execution and then clears the matching queued reservation.
 *
 * The compare-and-clear on the crawl token is critical: if this invocation somehow outlives its
 * lease, it must not clear a newer invocation's lease or its replacement dispatch.
 */
export async function releaseShopCrawl(
  db: QueryableDatabase,
  shopKey: string,
  crawlLeaseToken: string,
  requestedAt: string,
): Promise<void> {
  const released = await db
    .prepare(`
      UPDATE shop_sync_state
      SET crawl_lease_token = NULL, crawl_lease_until = NULL
      WHERE shop_key = ? AND crawl_lease_token = ?
    `)
    .bind(shopKey, crawlLeaseToken)
    .run();
  if (changes(released) === 0) return;

  const dispatchToken = crawlDispatchToken(shopKey, requestedAt);
  await db
    .prepare(`
      UPDATE shop_sync_state
      SET queued_at = NULL, queued_token = NULL, queued_last_sent_at = NULL
      WHERE shop_key = ?
        AND (
          queued_token = ?
          OR (queued_token IS NULL AND queued_at = ?)
        )
    `)
    .bind(shopKey, dispatchToken, requestedAt)
    .run();
}

/** Legacy helper kept for callers that only need to record a queue timestamp. */
export async function markShopQueued(
  db: QueryableDatabase,
  shopKey: string,
  queuedAt: string,
): Promise<void> {
  await db
    .prepare(`
    INSERT INTO shop_sync_state (shop_key, queued_at, queued_last_sent_at) VALUES (?, ?, ?)
    ON CONFLICT(shop_key) DO UPDATE SET
      queued_at = excluded.queued_at,
      queued_last_sent_at = excluded.queued_last_sent_at
  `)
    .bind(shopKey, queuedAt, queuedAt)
    .run();
}

/** Administrative/legacy clear; normal queue processing uses token-checked release functions. */
export async function clearShopQueued(db: QueryableDatabase, shopKey: string): Promise<void> {
  await db
    .prepare(
      "UPDATE shop_sync_state SET queued_at = NULL, queued_token = NULL, queued_last_sent_at = NULL WHERE shop_key = ?",
    )
    .bind(shopKey)
    .run();
}
