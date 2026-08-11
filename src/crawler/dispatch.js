import { SHOP_DEFINITIONS, getCrawlerSettings, getShopEnabled, getShopIntervalMinutes } from '../config.js';
import { crawlShop, isShopDue } from './run.js';
import { SHOP_ADAPTERS } from './shops/index.js';

function definitionFor(adapter) {
  return Object.values(SHOP_DEFINITIONS).find(definition => definition.key === adapter.key);
}

export function isDispatchLeaseActive(state, now = new Date(), leaseMinutes = 15) {
  if (!state?.queued_at) return false;
  const queuedAt = new Date(state.queued_at).getTime();
  if (!Number.isFinite(queuedAt)) return false;
  return now.getTime() - queuedAt < leaseMinutes * 60_000;
}

export function dueDispatchCandidates(env, stateRows = [], now = new Date(), { excludeShopKeys = [] } = {}) {
  const settings = getCrawlerSettings(env);
  const states = new Map(stateRows.map(row => [row.shop_key, row]));
  const excluded = new Set(excludeShopKeys);
  return SHOP_ADAPTERS
    .map(adapter => {
      if (excluded.has(adapter.key)) return null;
      const definition = definitionFor(adapter);
      const state = states.get(adapter.key) || null;
      if (!definition || !getShopEnabled(env, definition)) return null;
      if (adapter.isConfigured && !adapter.isConfigured(env)) return null;
      const intervalMinutes = getShopIntervalMinutes(env, definition);
      if (!isShopDue(state, intervalMinutes, now)) return null;
      if (isDispatchLeaseActive(state, now, settings.dispatchLeaseMinutes)) return null;
      return { adapter, state, lastAttempt: state?.last_attempt_at || '' };
    })
    .filter(Boolean)
    .sort((a, b) => a.lastAttempt.localeCompare(b.lastAttempt));
}

async function markQueued(db, shopKey, queuedAt) {
  await db.prepare(`
    INSERT INTO shop_sync_state (shop_key, queued_at) VALUES (?, ?)
    ON CONFLICT(shop_key) DO UPDATE SET queued_at = excluded.queued_at
  `).bind(shopKey, queuedAt).run();
}

export async function clearQueued(db, shopKey) {
  await db.prepare('UPDATE shop_sync_state SET queued_at = NULL WHERE shop_key = ?').bind(shopKey).run();
}

export async function dispatchDueCrawls(env, { now = new Date(), excludeShopKeys = [] } = {}) {
  if (!env.CRAWL_QUEUE) throw new Error('CRAWL_QUEUE binding is not configured');
  const statesResult = await env.DB.prepare('SELECT * FROM shop_sync_state').all();
  const candidates = dueDispatchCandidates(env, statesResult.results || [], now, { excludeShopKeys });
  const queuedAt = now.toISOString();
  const queued = [];

  for (const { adapter } of candidates) {
    await env.CRAWL_QUEUE.send({ shopKey: adapter.key, force: false, requestedAt: queuedAt });
    await markQueued(env.DB, adapter.key, queuedAt);
    queued.push(adapter.key);
  }

  return { status: queued.length ? 'queued' : 'skipped', queued };
}

export async function dispatchScheduledCrawl(env, shopKey, { now = new Date() } = {}) {
  if (!env.CRAWL_QUEUE) throw new Error('CRAWL_QUEUE binding is not configured');
  const adapter = SHOP_ADAPTERS.find(candidate => candidate.key === shopKey);
  if (!adapter) return { status: 'rejected', reason: 'unknown_shop' };
  const definition = definitionFor(adapter);
  if (!definition || !getShopEnabled(env, definition)) return { status: 'rejected', reason: 'disabled' };
  if (adapter.isConfigured && !adapter.isConfigured(env)) return { status: 'rejected', reason: 'configuration_missing' };

  const state = await env.DB.prepare('SELECT * FROM shop_sync_state WHERE shop_key = ?').bind(shopKey).first();
  const settings = getCrawlerSettings(env);
  if (isDispatchLeaseActive(state, now, settings.dispatchLeaseMinutes)) {
    return { status: 'skipped', reason: 'dispatch_lease_active', shopKey };
  }

  const queuedAt = now.toISOString();
  await env.CRAWL_QUEUE.send({ shopKey, force: true, requestedAt: queuedAt });
  await markQueued(env.DB, shopKey, queuedAt);
  return { status: 'queued', shopKey };
}

export async function dispatchForcedCrawl(env, shopKey, { now = new Date() } = {}) {
  if (!env.CRAWL_QUEUE) throw new Error('CRAWL_QUEUE binding is not configured');
  const adapter = SHOP_ADAPTERS.find(candidate => candidate.key === shopKey);
  if (!adapter) return { status: 'rejected', reason: 'unknown_shop' };
  const definition = definitionFor(adapter);
  if (!definition || !getShopEnabled(env, definition)) return { status: 'rejected', reason: 'disabled' };
  const queuedAt = now.toISOString();
  await env.CRAWL_QUEUE.send({ shopKey, force: true, requestedAt: queuedAt });
  await markQueued(env.DB, shopKey, queuedAt);
  return { status: 'queued', shopKey };
}

export async function consumeCrawlMessage(env, body) {
  const shopKey = body?.shopKey;
  const adapter = SHOP_ADAPTERS.find(candidate => candidate.key === shopKey);
  if (!adapter) return { status: 'skipped', reason: 'unknown_shop', shopKey };
  await clearQueued(env.DB, shopKey);
  return crawlShop(env, adapter, { force: body?.force === true });
}
