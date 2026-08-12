import { getCrawlerSettings, getShopEnabled, getShopIntervalMinutes } from "../config.js";
import {
  clearShopQueued,
  getShopState,
  listShopStates,
  markShopQueued,
} from "../db/shop-state-repository.js";
import { recheckAudioUnionInventory } from "./inventory-recheck.js";
import { crawlShop, isShopDue } from "./run.js";
import { getShopPlugin, SHOP_PLUGINS } from "./shops/index.js";
import { isTransportConfigured } from "./transport.js";

function definitionFor(plugin) {
  return plugin?.definition;
}

function isConfigured(env, plugin) {
  if (!isTransportConfigured(env, plugin)) return false;
  if (plugin.transport === "relay") return true;
  return !plugin.isConfigured || plugin.isConfigured(env);
}

export function isDispatchLeaseActive(state, now = new Date(), leaseMinutes = 15) {
  if (!state?.queued_at) return false;
  const queuedAt = new Date(state.queued_at).getTime();
  if (!Number.isFinite(queuedAt)) return false;
  return now.getTime() - queuedAt < leaseMinutes * 60_000;
}

export function dueDispatchCandidates(
  env,
  stateRows = [],
  now = new Date(),
  { excludeShopKeys = [] } = {},
) {
  const settings = getCrawlerSettings(env);
  const states = new Map(stateRows.map((row) => [row.shop_key, row]));
  const excluded = new Set(excludeShopKeys);
  return SHOP_PLUGINS.map((plugin) => {
    if (excluded.has(plugin.key)) return null;
    const definition = definitionFor(plugin);
    const state = states.get(plugin.key) || null;
    if (!definition || !getShopEnabled(env, definition)) return null;
    if (!isConfigured(env, plugin)) return null;
    const intervalMinutes = getShopIntervalMinutes(env, definition);
    if (!isShopDue(state, intervalMinutes, now)) return null;
    if (isDispatchLeaseActive(state, now, settings.dispatchLeaseMinutes)) return null;
    return { adapter: plugin, state, lastAttempt: state?.last_attempt_at || "" };
  })
    .filter(Boolean)
    .sort((a, b) => a.lastAttempt.localeCompare(b.lastAttempt));
}

export async function clearQueued(db, shopKey) {
  return clearShopQueued(db, shopKey);
}

export async function dispatchDueCrawls(env, { now = new Date(), excludeShopKeys = [] } = {}) {
  if (!env.CRAWL_QUEUE) throw new Error("CRAWL_QUEUE binding is not configured");
  const candidates = dueDispatchCandidates(env, await listShopStates(env.DB), now, {
    excludeShopKeys,
  });
  const queuedAt = now.toISOString();
  const queued = [];

  for (const { adapter } of candidates) {
    await env.CRAWL_QUEUE.send({ shopKey: adapter.key, force: false, requestedAt: queuedAt });
    await markShopQueued(env.DB, adapter.key, queuedAt);
    queued.push(adapter.key);
  }

  return { status: queued.length ? "queued" : "skipped", queued };
}

export async function dispatchScheduledCrawl(env, shopKey, { now = new Date() } = {}) {
  if (!env.CRAWL_QUEUE) throw new Error("CRAWL_QUEUE binding is not configured");
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "rejected", reason: "unknown_shop" };
  const definition = definitionFor(plugin);
  if (!definition || !getShopEnabled(env, definition))
    return { status: "rejected", reason: "disabled" };
  if (!isConfigured(env, plugin)) return { status: "rejected", reason: "configuration_missing" };

  const state = await getShopState(env.DB, shopKey);
  const settings = getCrawlerSettings(env);
  if (isDispatchLeaseActive(state, now, settings.dispatchLeaseMinutes)) {
    return { status: "skipped", reason: "dispatch_lease_active", shopKey };
  }

  const queuedAt = now.toISOString();
  await env.CRAWL_QUEUE.send({ shopKey, force: true, requestedAt: queuedAt });
  await markShopQueued(env.DB, shopKey, queuedAt);
  return { status: "queued", shopKey };
}

export async function dispatchForcedCrawl(env, shopKey, { now = new Date() } = {}) {
  if (!env.CRAWL_QUEUE) throw new Error("CRAWL_QUEUE binding is not configured");
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "rejected", reason: "unknown_shop" };
  const definition = definitionFor(plugin);
  if (!definition || !getShopEnabled(env, definition))
    return { status: "rejected", reason: "disabled" };
  if (!isConfigured(env, plugin)) return { status: "rejected", reason: "configuration_missing" };
  const queuedAt = now.toISOString();
  await env.CRAWL_QUEUE.send({ shopKey, force: true, requestedAt: queuedAt });
  await markShopQueued(env.DB, shopKey, queuedAt);
  return { status: "queued", shopKey };
}

export async function consumeCrawlMessage(env, body) {
  const shopKey = body?.shopKey;
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "skipped", reason: "unknown_shop", shopKey };
  await clearShopQueued(env.DB, shopKey);

  const crawlResult = await crawlShop(env, plugin, { force: body?.force === true });
  if (shopKey !== "audiounion" || crawlResult.status !== "success") return crawlResult;

  const inventoryRecheck = await recheckAudioUnionInventory(env);
  return { ...crawlResult, inventoryRecheck };
}
