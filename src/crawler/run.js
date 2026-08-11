import {
  SHOP_DEFINITIONS,
  getCrawlerSettings,
  getShopEnabled,
  getShopIntervalMinutes,
  getShopMaxPages,
  getShopRequestDelayMs
} from '../config.js';
import { upsertProducts } from '../db/products.js';
import {
  getShopState,
  listShopStates,
  markShopAttempt,
  markShopFailure,
  markShopSuccess
} from '../db/shop-state-repository.js';
import {
  finishCrawlRunFailure,
  finishCrawlRunSuccess,
  startCrawlRun
} from '../db/crawl-run-repository.js';
import { SHOP_ADAPTERS } from './shops/index.js';
import { createTransport, isTransportConfigured } from './transport.js';
import {
  coverageDecision,
  discoverPages,
  initialPageQueue,
  pageUrl,
  shouldContinueAfterEmpty
} from './strategies.js';

function nowIso(now = new Date()) { return now.toISOString(); }

function definitionFor(adapter) {
  return adapter.definition || Object.values(SHOP_DEFINITIONS).find(value => value.key === adapter.key);
}

function isConfigured(env, adapter) {
  return isTransportConfigured(env, adapter) && (!adapter.isConfigured || adapter.isConfigured(env));
}

export function isShopDue(state, intervalMinutes, now = new Date()) {
  if (state?.backoff_until && new Date(state.backoff_until) > now) return false;
  if (!state?.last_attempt_at) return true;
  return now.getTime() - new Date(state.last_attempt_at).getTime() >= intervalMinutes * 60_000;
}

export function isSuspiciousItemDrop(itemCount, previousItemCount, { minRatio = 0.5, minBaseline = 20 } = {}) {
  if (!Number.isFinite(previousItemCount) || previousItemCount < minBaseline) return false;
  if (!Number.isFinite(itemCount) || itemCount < 0) return true;
  return itemCount / previousItemCount < minRatio;
}

export async function crawlShop(env, adapter, { force = false, now = new Date(), fetchFn = fetch } = {}) {
  const definition = definitionFor(adapter);
  if (!definition) return { shopKey: adapter.key, status: 'skipped', reason: 'shop_definition_missing' };
  if (!getShopEnabled(env, definition)) return { shopKey: adapter.key, status: 'skipped', reason: 'disabled' };
  if (!isConfigured(env, adapter)) return { shopKey: adapter.key, status: 'skipped', reason: 'configuration_missing' };

  const intervalMinutes = getShopIntervalMinutes(env, definition);
  const state = await getShopState(env.DB, adapter.key);
  if (!force && !isShopDue(state, intervalMinutes, now)) return { shopKey: adapter.key, status: 'skipped', reason: 'not_due' };

  const startedAt = nowIso(now);
  await markShopAttempt(env.DB, adapter.key, startedAt);
  const runId = await startCrawlRun(env.DB, adapter.key, startedAt);
  const settings = getCrawlerSettings(env);
  const maxPages = getShopMaxPages(env, definition, settings.maxPagesPerShop);
  const pageLimit = maxPages + Math.max(0, adapter.extraPageAllowance || 0);
  const requestDelayMs = getShopRequestDelayMs(env, definition, settings.requestDelayMs);
  const robotsCache = new Map();
  const items = new Map();
  let pageCount = 0;
  let reachedEnd = false;
  let coverageIncomplete = false;
  const transport = createTransport(env, adapter, fetchFn);

  try {
    const pageQueue = initialPageQueue(adapter, maxPages, env, { now, intervalMinutes, state });
    const queuedUrls = new Set(pageQueue.map(pageUrl));

    while (pageQueue.length && pageCount < pageLimit) {
      const page = pageQueue.shift();
      const url = pageUrl(page);
      let html;
      try {
        html = await transport.fetchHtmlPage(url, {
          baseUrl: adapter.baseUrl,
          userAgent: settings.userAgent,
          requestDelayMs,
          fetchFn,
          robotsCache
        });
      } catch (error) {
        if (/HTTP 404/.test(error.message) && (shouldContinueAfterEmpty(adapter) || items.size === 0)) {
          coverageIncomplete = true;
          continue;
        }
        throw error;
      }

      pageCount += 1;
      const parsed = adapter.parse(html, page);
      const discovered = discoverPages(adapter, html, page);
      if (discovered == null) {
        coverageIncomplete = true;
      } else {
        for (const nextPage of discovered) {
          const nextUrl = pageUrl(nextPage);
          if (!nextUrl || queuedUrls.has(nextUrl)) continue;
          queuedUrls.add(nextUrl);
          pageQueue.push(nextPage);
        }
      }

      if (!parsed.length) {
        if (adapter.dynamicPagination) coverageIncomplete = true;
        if (items.size > 0) {
          if (shouldContinueAfterEmpty(adapter)) continue;
          reachedEnd = true;
          break;
        }
      }

      for (const item of parsed) items.set(item.sourceId, item);
    }

    if (pageQueue.length) coverageIncomplete = true;
    if (!items.size) throw new Error('no products parsed; refusing to mark existing products inactive');

    const { deactivateMissing, guardItemCount } = coverageDecision(adapter, {
      reachedEnd,
      coverageIncomplete,
      queueEmpty: pageQueue.length === 0
    });
    if (guardItemCount && isSuspiciousItemDrop(items.size, Number(state?.last_item_count), {
      minRatio: settings.minItemRatio,
      minBaseline: settings.minItemBaseline
    })) {
      throw new Error(`item count dropped suspiciously from ${state.last_item_count} to ${items.size}; refusing crawl update`);
    }

    const observedAt = nowIso(new Date());
    const { changedCount, touchedCount, deactivatedCount } = await upsertProducts(
      env.DB,
      adapter.key,
      [...items.values()],
      observedAt,
      { deactivateMissing, touchIntervalMinutes: settings.productTouchIntervalMinutes }
    );
    await markShopSuccess(env.DB, adapter.key, observedAt, items.size);
    await finishCrawlRunSuccess(env.DB, runId, {
      finishedAt: observedAt,
      itemCount: items.size,
      pageCount,
      message: `${changedCount} changed, ${touchedCount} touched, ${deactivatedCount} deactivated`
    });
    return { shopKey: adapter.key, status: 'success', itemCount: items.size, pageCount, changedCount, touchedCount, deactivatedCount, deactivateMissing };
  } catch (error) {
    const failedAt = nowIso(new Date());
    await markShopFailure(env.DB, adapter.key, failedAt, error.message, state?.consecutive_failures || 0);
    await finishCrawlRunFailure(env.DB, runId, { finishedAt: failedAt, pageCount, message: error.message });
    return { shopKey: adapter.key, status: 'failed', error: error.message };
  } finally {
    await transport.close?.();
  }
}

export async function crawlDueShops(env, options = {}) {
  const results = [];
  for (const adapter of SHOP_ADAPTERS) results.push(await crawlShop(env, adapter, options));
  return results;
}

export async function crawlNextDueShop(env, { now = new Date(), fetchFn = fetch } = {}) {
  const states = new Map((await listShopStates(env.DB)).map(row => [row.shop_key, row]));
  const candidates = SHOP_ADAPTERS
    .filter(adapter => {
      const definition = definitionFor(adapter);
      return definition && getShopEnabled(env, definition) && isConfigured(env, adapter);
    })
    .map(adapter => {
      const definition = definitionFor(adapter);
      const interval = getShopIntervalMinutes(env, definition);
      const state = states.get(adapter.key);
      return { adapter, state, interval, due: isShopDue(state, interval, now), lastAttempt: state?.last_attempt_at || '' };
    })
    .filter(candidate => candidate.due)
    .sort((a, b) => a.lastAttempt.localeCompare(b.lastAttempt));
  if (!candidates.length) return { status: 'skipped', reason: 'no_shop_due' };
  return crawlShop(env, candidates[0].adapter, { now, fetchFn });
}
