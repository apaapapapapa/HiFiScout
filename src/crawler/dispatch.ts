import { getCrawlerSettings, getShopEnabled, getShopIntervalMinutes } from "../config.js";
import {
  clearShopQueued,
  crawlDispatchToken,
  getShopState,
  listShopStates,
  markShopDispatchSent,
  releaseShopCrawl,
  releaseShopDispatch,
  reserveShopDispatch,
  tryClaimShopCrawl,
} from "../db/shop-state-repository.js";
import { syncProductSearchEntities } from "../db/product-search-entity-repository.js";
import {
  hasDispatchReservation,
  matchesDispatchReservation,
  retryAfterExecutionLeaseSeconds,
  shouldRecoverDispatch,
  type CrawlLifecycleRow,
} from "./crawl-lifecycle.js";
import { recheckShopInventory } from "./inventory-recheck.js";
import { crawlQueueLane, crawlQueueSender } from "./queue-lanes.js";
import { crawlShop, isShopDue } from "./run.js";
import { getShopPlugin, SHOP_PLUGINS } from "./shops/index.js";
import { isTransportConfigured } from "./transport.js";
import type { QueryableDatabase, ShopSyncStateRow } from "../db/types.js";
import type {
  CrawlQueueMessage,
  CrawlerEnv,
  CrawlResult,
  DispatchResult,
  DueDispatchCandidate,
  InventoryRecheckResult,
  ShopPlugin,
} from "./types.js";

type RuntimeEnv = CrawlerEnv & { DB: QueryableDatabase };
type ProductSearchEntitySync = typeof syncProductSearchEntities;

/** Cloudflare Queue consumer invocations have a 15-minute wall-clock limit. */
export const CRAWL_EXECUTION_LEASE_MINUTES = 20;
const CRAWL_RETRY_SAFETY_SECONDS = 5;

interface DispatchOptions {
  now?: Date;
  excludeShopKeys?: string[];
}

interface DispatchAtOptions {
  now?: Date;
}

interface RecoveryOptions {
  now?: Date;
  recoveryMinutes?: number;
}

function isConfigured(env: CrawlerEnv, plugin: ShopPlugin): boolean {
  return isTransportConfigured(env, plugin.capabilities.transport?.kind);
}

/**
 * A queued child job stays reserved until its consumer or DLQ explicitly releases it. Time alone
 * must never make it eligible for a replacement dispatch, otherwise a congested queue can keep
 * moving the same shop to the tail forever.
 */
export function isDispatchLeaseActive(
  state: Partial<Pick<ShopSyncStateRow, "queued_at">> | null | undefined,
  now = new Date(),
  leaseMinutes = 15,
): boolean {
  void now;
  void leaseMinutes;
  return hasDispatchReservation(state);
}

export function dueDispatchCandidates(
  env: CrawlerEnv,
  stateRows: readonly ShopSyncStateRow[] = [],
  now = new Date(),
  { excludeShopKeys = [] }: Pick<DispatchOptions, "excludeShopKeys"> = {},
): DueDispatchCandidate[] {
  const states = new Map(stateRows.map((row) => [row.shop_key, row]));
  const excluded = new Set(excludeShopKeys);
  return SHOP_PLUGINS.map((plugin) => {
    if (excluded.has(plugin.key)) return null;
    const definition = plugin.definition;
    const state = states.get(plugin.key) || null;
    if (!getShopEnabled(env, definition)) return null;
    if (!isConfigured(env, plugin)) return null;
    const intervalMinutes = getShopIntervalMinutes(env, definition);
    if (!isShopDue(state, intervalMinutes, now)) return null;
    if (isDispatchLeaseActive(state, now)) return null;
    return { adapter: plugin, state, lastAttempt: state?.last_attempt_at || "" };
  })
    .filter((candidate): candidate is DueDispatchCandidate => candidate !== null)
    .sort((a, b) => a.lastAttempt.localeCompare(b.lastAttempt));
}

export async function clearQueued(db: QueryableDatabase, shopKey: string): Promise<void> {
  return clearShopQueued(db, shopKey);
}

async function enqueueReservedCrawl(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  force: boolean,
  requestedAt: string,
  batchRunId: string,
  leaseMinutes: number,
): Promise<boolean> {
  const destination = crawlQueueSender(env, plugin);
  if (!destination) throw new Error(`crawl queue binding is not configured for ${plugin.key}`);
  const dispatchToken = await reserveShopDispatch(env.DB, plugin.key, requestedAt, leaseMinutes);
  if (!dispatchToken) return false;

  const message: CrawlQueueMessage = {
    shopKey: plugin.key,
    force,
    requestedAt,
    jobId: dispatchToken,
    batchRunId,
    lane: destination.lane,
  };
  try {
    await destination.queue.send(message);
    return true;
  } catch (error) {
    await releaseShopDispatch(env.DB, plugin.key, dispatchToken);
    throw error;
  }
}

function newBatchRunId(requestedAt: string): string {
  return `crawl-batch:${requestedAt}:${crypto.randomUUID()}`;
}

function logBatchDispatch(
  batchRunId: string,
  requestedAt: string,
  queued: readonly string[],
  candidates: readonly DueDispatchCandidate[],
): void {
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.adapter.key, candidate]));
  const lanes = { fast: 0, heavy: 0, relay: 0 };
  for (const shopKey of queued) {
    const candidate = candidateByKey.get(shopKey);
    if (!candidate) continue;
    lanes[crawlQueueLane(candidate.adapter)] += 1;
  }
  console.log(
    JSON.stringify({
      event: "crawl_batch_dispatched",
      batchRunId,
      requestedAt,
      candidateCount: candidates.length,
      queuedCount: queued.length,
      queued,
      lanes,
    }),
  );
}

/**
 * Re-sends an orphaned logical child without changing its requestedAt/token.
 *
 * This is a watchdog, not a second scheduler. Duplicate deliveries remain safe because every copy
 * carries the same dispatch identity and `tryClaimShopCrawl` enforces single-flight execution.
 * Keeping the original identity avoids the queue-tail starvation caused by replacing stale jobs.
 */
export async function recoverStalledCrawlDispatches(
  env: RuntimeEnv,
  {
    now = new Date(),
    recoveryMinutes = getCrawlerSettings(env).dispatchLeaseMinutes,
  }: RecoveryOptions = {},
): Promise<string[]> {
  const recovered: string[] = [];
  const states = (await listShopStates(env.DB)) as CrawlLifecycleRow[];
  const recoveredAt = now.toISOString();
  const batchRunId = `crawl-recovery:${recoveredAt}:${crypto.randomUUID()}`;

  for (const state of states) {
    if (!shouldRecoverDispatch(state, now, recoveryMinutes) || !state.queued_at) continue;
    const plugin = getShopPlugin(state.shop_key);
    if (!plugin || !getShopEnabled(env, plugin.definition) || !isConfigured(env, plugin)) continue;
    const destination = crawlQueueSender(env, plugin);
    if (!destination) {
      console.error(
        JSON.stringify({
          event: "crawl_dispatch_recovery_failed",
          shopKey: state.shop_key,
          requestedAt: state.queued_at,
          reason: "queue_binding_missing",
        }),
      );
      continue;
    }

    const dispatchToken = state.queued_token || crawlDispatchToken(plugin.key, state.queued_at);
    const message: CrawlQueueMessage = {
      shopKey: plugin.key,
      // Legacy metadata only. A successful D1 lifecycle claim is the execution authorization.
      force: true,
      requestedAt: state.queued_at,
      jobId: dispatchToken,
      batchRunId,
      lane: destination.lane,
    };

    try {
      await destination.queue.send(message);
      await markShopDispatchSent(env.DB, plugin.key, dispatchToken, recoveredAt);
      recovered.push(plugin.key);
      console.warn(
        JSON.stringify({
          event: "crawl_dispatch_recovered",
          shopKey: plugin.key,
          requestedAt: state.queued_at,
          recoveredAt,
          jobId: dispatchToken,
          batchRunId,
          lane: destination.lane,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "crawl_dispatch_recovery_failed",
          shopKey: plugin.key,
          requestedAt: state.queued_at,
          jobId: dispatchToken,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return recovered;
}

export async function dispatchDueCrawls(
  env: RuntimeEnv,
  { now = new Date(), excludeShopKeys = [] }: DispatchOptions = {},
): Promise<DispatchResult> {
  const settings = getCrawlerSettings(env);
  // Recovery intentionally scans every shop, including dedicated-cron shops. The general five-
  // minute sweep is the common watchdog for all lane consumers.
  await recoverStalledCrawlDispatches(env, {
    now,
    recoveryMinutes: settings.dispatchLeaseMinutes,
  });
  const candidates = dueDispatchCandidates(env, await listShopStates(env.DB), now, {
    excludeShopKeys,
  });
  const queuedAt = now.toISOString();
  const batchRunId = newBatchRunId(queuedAt);
  const queued: string[] = [];

  for (const { adapter } of candidates) {
    const reserved = await enqueueReservedCrawl(
      env,
      adapter,
      false,
      queuedAt,
      batchRunId,
      settings.dispatchLeaseMinutes,
    );
    if (reserved) queued.push(adapter.key);
  }

  logBatchDispatch(batchRunId, queuedAt, queued, candidates);
  return queued.length ? { status: "queued", queued } : { status: "skipped", queued };
}

async function dispatchOneCrawl(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  force: boolean,
  now: Date,
): Promise<DispatchResult> {
  const state = await getShopState(env.DB, plugin.key);
  const settings = getCrawlerSettings(env);
  if (isDispatchLeaseActive(state, now, settings.dispatchLeaseMinutes)) {
    return { status: "skipped", reason: "dispatch_lease_active", shopKey: plugin.key };
  }

  const queuedAt = now.toISOString();
  const batchRunId = newBatchRunId(queuedAt);
  const reserved = await enqueueReservedCrawl(
    env,
    plugin,
    force,
    queuedAt,
    batchRunId,
    settings.dispatchLeaseMinutes,
  );
  console.log(
    JSON.stringify({
      event: "crawl_batch_dispatched",
      batchRunId,
      requestedAt: queuedAt,
      candidateCount: 1,
      queuedCount: reserved ? 1 : 0,
      queued: reserved ? [plugin.key] : [],
      lanes: { [crawlQueueLane(plugin)]: reserved ? 1 : 0 },
    }),
  );
  return reserved
    ? { status: "queued", shopKey: plugin.key }
    : { status: "skipped", reason: "dispatch_lease_active", shopKey: plugin.key };
}

export async function dispatchScheduledCrawl(
  env: RuntimeEnv,
  shopKey: string | null | undefined,
  { now = new Date() }: DispatchAtOptions = {},
): Promise<DispatchResult> {
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "rejected", reason: "unknown_shop" };
  if (!getShopEnabled(env, plugin.definition)) return { status: "rejected", reason: "disabled" };
  if (!isConfigured(env, plugin)) return { status: "rejected", reason: "configuration_missing" };
  return dispatchOneCrawl(env, plugin, true, now);
}

export async function dispatchForcedCrawl(
  env: RuntimeEnv,
  shopKey: string | null | undefined,
  { now = new Date() }: DispatchAtOptions = {},
): Promise<DispatchResult> {
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "rejected", reason: "unknown_shop" };
  if (!getShopEnabled(env, plugin.definition)) return { status: "rejected", reason: "disabled" };
  if (!isConfigured(env, plugin)) return { status: "rejected", reason: "configuration_missing" };
  return dispatchOneCrawl(env, plugin, true, now);
}

/**
 * Compatibility bridge between the explicit dispatch lifecycle and the crawler's historical
 * boolean schedule bypass. Only a successfully claimed Queue child may enter through this path.
 */
async function executeClaimedDispatch(env: RuntimeEnv, plugin: ShopPlugin): Promise<CrawlResult> {
  return crawlShop(env, plugin, { force: true });
}

export async function consumeCrawlMessage(
  env: RuntimeEnv,
  body: Partial<CrawlQueueMessage> | null | undefined,
): Promise<CrawlResult> {
  const shopKey = body?.shopKey;
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "skipped", reason: "unknown_shop", shopKey };
  const resolvedShopKey = plugin.key;
  const requestedAt = body?.requestedAt;
  if (!requestedAt) {
    console.warn(
      JSON.stringify({
        event: "crawl_queue_message_rejected",
        shopKey: resolvedShopKey,
        reason: "missing_requested_at",
      }),
    );
    return { status: "skipped", reason: "not_due", shopKey: resolvedShopKey };
  }

  const claimedAtDate = new Date();
  const claimedAt = claimedAtDate.toISOString();
  const crawlLeaseToken = await tryClaimShopCrawl(
    env.DB,
    resolvedShopKey,
    requestedAt,
    claimedAt,
    CRAWL_EXECUTION_LEASE_MINUTES,
  );
  if (!crawlLeaseToken) {
    const state = (await getShopState(env.DB, resolvedShopKey)) as CrawlLifecycleRow | null;
    const retryAfterSeconds = matchesDispatchReservation(state, resolvedShopKey, requestedAt)
      ? retryAfterExecutionLeaseSeconds(state, claimedAtDate, CRAWL_RETRY_SAFETY_SECONDS)
      : null;
    if (retryAfterSeconds != null) {
      console.log(
        JSON.stringify({
          event: "crawl_queue_single_flight_deferred",
          shopKey: resolvedShopKey,
          requestedAt,
          jobId: body.jobId || crawlDispatchToken(resolvedShopKey, requestedAt),
          batchRunId: body.batchRunId || null,
          retryAfterSeconds,
          observedAt: claimedAt,
        }),
      );
      return {
        status: "skipped",
        reason: "crawl_in_progress",
        shopKey: resolvedShopKey,
        retryAfterSeconds,
      };
    }

    console.log(
      JSON.stringify({
        event: "crawl_queue_stale_delivery_suppressed",
        shopKey: resolvedShopKey,
        requestedAt,
        jobId: body.jobId || crawlDispatchToken(resolvedShopKey, requestedAt),
        batchRunId: body.batchRunId || null,
        observedAt: claimedAt,
      }),
    );
    return { status: "skipped", reason: "stale_dispatch", shopKey: resolvedShopKey };
  }

  try {
    const crawlResult = await executeClaimedDispatch(env, plugin);
    // Rechecking after a failed crawl would spend the shop's request budget on stale candidates.
    if (crawlResult.status !== "success" || !plugin.capabilities.inventoryRecheck) {
      return crawlResult;
    }

    const inventoryRecheck = await recheckShopInventory(env, plugin);
    await syncInventoryRecheckSearchEntities(env.DB, resolvedShopKey, inventoryRecheck);
    return { ...crawlResult, inventoryRecheck };
  } finally {
    await releaseShopCrawl(env.DB, resolvedShopKey, crawlLeaseToken, requestedAt);
  }
}

/** Refreshes the one entity whose listing facts an inventory recheck may have changed. */
export async function syncInventoryRecheckSearchEntities(
  db: QueryableDatabase,
  shopKey: string,
  result: InventoryRecheckResult,
  sync: ProductSearchEntitySync = syncProductSearchEntities,
): Promise<void> {
  if (result.status !== "checked" || !result.sourceId) return;
  await sync(db, shopKey, [result.sourceId]);
}
