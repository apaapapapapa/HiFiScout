import { getCrawlerSettings, getShopEnabled, getShopIntervalMinutes } from "../config.js";
import {
  clearShopQueued,
  getShopState,
  listShopStates,
  releaseShopCrawl,
  releaseShopDispatch,
  reserveShopDispatch,
  tryClaimShopCrawl,
} from "../db/shop-state-repository.js";
import { syncProductSearchEntities } from "../db/product-search-entity-repository.js";
import { recheckShopInventory } from "./inventory-recheck.js";
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
const CRAWL_EXECUTION_LEASE_MINUTES = 20;

interface DispatchOptions {
  now?: Date;
  excludeShopKeys?: string[];
}

interface DispatchAtOptions {
  now?: Date;
}

function isConfigured(env: CrawlerEnv, plugin: ShopPlugin): boolean {
  return isTransportConfigured(env, plugin.capabilities.transport?.kind);
}

export function isDispatchLeaseActive(
  state: Partial<Pick<ShopSyncStateRow, "queued_at">> | null | undefined,
  now = new Date(),
  leaseMinutes = 15,
): boolean {
  if (!state?.queued_at) return false;
  const queuedAt = new Date(state.queued_at).getTime();
  if (!Number.isFinite(queuedAt)) return false;
  return now.getTime() - queuedAt < leaseMinutes * 60_000;
}

export function dueDispatchCandidates(
  env: CrawlerEnv,
  stateRows: readonly ShopSyncStateRow[] = [],
  now = new Date(),
  { excludeShopKeys = [] }: Pick<DispatchOptions, "excludeShopKeys"> = {},
): DueDispatchCandidate[] {
  const settings = getCrawlerSettings(env);
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
    if (isDispatchLeaseActive(state, now, settings.dispatchLeaseMinutes)) return null;
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
  shopKey: string,
  force: boolean,
  requestedAt: string,
  leaseMinutes: number,
): Promise<boolean> {
  if (!env.CRAWL_QUEUE) throw new Error("CRAWL_QUEUE binding is not configured");
  const dispatchToken = await reserveShopDispatch(
    env.DB,
    shopKey,
    requestedAt,
    leaseMinutes,
  );
  if (!dispatchToken) return false;

  try {
    await env.CRAWL_QUEUE.send({ shopKey, force, requestedAt });
    return true;
  } catch (error) {
    await releaseShopDispatch(env.DB, shopKey, dispatchToken);
    throw error;
  }
}

export async function dispatchDueCrawls(
  env: RuntimeEnv,
  { now = new Date(), excludeShopKeys = [] }: DispatchOptions = {},
): Promise<DispatchResult> {
  if (!env.CRAWL_QUEUE) throw new Error("CRAWL_QUEUE binding is not configured");
  const settings = getCrawlerSettings(env);
  const candidates = dueDispatchCandidates(env, await listShopStates(env.DB), now, {
    excludeShopKeys,
  });
  const queuedAt = now.toISOString();
  const queued: string[] = [];

  for (const { adapter } of candidates) {
    const reserved = await enqueueReservedCrawl(
      env,
      adapter.key,
      false,
      queuedAt,
      settings.dispatchLeaseMinutes,
    );
    if (reserved) queued.push(adapter.key);
  }

  return queued.length ? { status: "queued", queued } : { status: "skipped", queued };
}

export async function dispatchScheduledCrawl(
  env: RuntimeEnv,
  shopKey: string | null | undefined,
  { now = new Date() }: DispatchAtOptions = {},
): Promise<DispatchResult> {
  if (!env.CRAWL_QUEUE) throw new Error("CRAWL_QUEUE binding is not configured");
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "rejected", reason: "unknown_shop" };
  const resolvedShopKey = plugin.key;
  if (!getShopEnabled(env, plugin.definition)) return { status: "rejected", reason: "disabled" };
  if (!isConfigured(env, plugin)) return { status: "rejected", reason: "configuration_missing" };

  const state = await getShopState(env.DB, resolvedShopKey);
  const settings = getCrawlerSettings(env);
  if (isDispatchLeaseActive(state, now, settings.dispatchLeaseMinutes)) {
    return { status: "skipped", reason: "dispatch_lease_active", shopKey: resolvedShopKey };
  }

  const queuedAt = now.toISOString();
  const reserved = await enqueueReservedCrawl(
    env,
    resolvedShopKey,
    true,
    queuedAt,
    settings.dispatchLeaseMinutes,
  );
  return reserved
    ? { status: "queued", shopKey: resolvedShopKey }
    : { status: "skipped", reason: "dispatch_lease_active", shopKey: resolvedShopKey };
}

export async function dispatchForcedCrawl(
  env: RuntimeEnv,
  shopKey: string | null | undefined,
  { now = new Date() }: DispatchAtOptions = {},
): Promise<DispatchResult> {
  if (!env.CRAWL_QUEUE) throw new Error("CRAWL_QUEUE binding is not configured");
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "rejected", reason: "unknown_shop" };
  const resolvedShopKey = plugin.key;
  if (!getShopEnabled(env, plugin.definition)) return { status: "rejected", reason: "disabled" };
  if (!isConfigured(env, plugin)) return { status: "rejected", reason: "configuration_missing" };

  const settings = getCrawlerSettings(env);
  const queuedAt = now.toISOString();
  const reserved = await enqueueReservedCrawl(
    env,
    resolvedShopKey,
    true,
    queuedAt,
    settings.dispatchLeaseMinutes,
  );
  return reserved
    ? { status: "queued", shopKey: resolvedShopKey }
    : { status: "skipped", reason: "dispatch_lease_active", shopKey: resolvedShopKey };
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

  const claimedAt = new Date().toISOString();
  const crawlLeaseToken = await tryClaimShopCrawl(
    env.DB,
    resolvedShopKey,
    requestedAt,
    claimedAt,
    CRAWL_EXECUTION_LEASE_MINUTES,
  );
  if (!crawlLeaseToken) {
    console.log(
      JSON.stringify({
        event: "crawl_queue_duplicate_suppressed",
        shopKey: resolvedShopKey,
        requestedAt,
        observedAt: claimedAt,
      }),
    );
    return { status: "skipped", reason: "not_due", shopKey: resolvedShopKey };
  }

  try {
    const crawlResult = await crawlShop(env, plugin, { force: body?.force === true });
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
