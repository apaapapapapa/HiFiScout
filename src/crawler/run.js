import { SHOP_DEFINITIONS, getCrawlerSettings, getShopIntervalMinutes, getShopMaxPages } from '../config.js';
import { upsertProducts } from '../db/products.js';
import { createBrowserHtmlFetcher } from './browser.js';
import { fetchHtmlPage } from './fetch.js';
import { SHOP_ADAPTERS } from './shops/index.js';

function nowIso(now = new Date()) { return now.toISOString(); }

export function isShopDue(state, intervalMinutes, now = new Date()) {
  if (state?.backoff_until && new Date(state.backoff_until) > now) return false;
  if (!state?.last_attempt_at) return true;
  return now.getTime() - new Date(state.last_attempt_at).getTime() >= intervalMinutes * 60_000;
}

async function markAttempt(db, shopKey, now) {
  await db.prepare(`
    INSERT INTO shop_sync_state (shop_key, last_attempt_at) VALUES (?, ?)
    ON CONFLICT(shop_key) DO UPDATE SET last_attempt_at = excluded.last_attempt_at
  `).bind(shopKey, now).run();
}

async function markSuccess(db, shopKey, now, itemCount) {
  await db.prepare(`
    INSERT INTO shop_sync_state (shop_key, last_success_at, consecutive_failures, backoff_until, last_error, last_item_count)
    VALUES (?, ?, 0, NULL, NULL, ?)
    ON CONFLICT(shop_key) DO UPDATE SET last_success_at = excluded.last_success_at,
      consecutive_failures = 0, backoff_until = NULL, last_error = NULL, last_item_count = excluded.last_item_count
  `).bind(shopKey, now, itemCount).run();
}

async function markFailure(db, shopKey, now, message, priorFailures = 0) {
  const failures = priorFailures + 1;
  const backoffMinutes = Math.min(24 * 60, 15 * 2 ** Math.min(failures - 1, 6));
  const backoffUntil = new Date(new Date(now).getTime() + backoffMinutes * 60_000).toISOString();
  await db.prepare(`
    INSERT INTO shop_sync_state (shop_key, last_error_at, consecutive_failures, backoff_until, last_error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop_key) DO UPDATE SET last_error_at = excluded.last_error_at,
      consecutive_failures = excluded.consecutive_failures, backoff_until = excluded.backoff_until, last_error = excluded.last_error
  `).bind(shopKey, now, failures, backoffUntil, String(message).slice(0, 1000)).run();
}

function pageUrl(page) {
  return typeof page === 'string' ? page : page.url;
}

export async function crawlShop(env, adapter, { force = false, now = new Date(), fetchFn = fetch } = {}) {
  const definition = Object.values(SHOP_DEFINITIONS).find(v => v.key === adapter.key);
  if (adapter.isConfigured && !adapter.isConfigured(env)) return { shopKey: adapter.key, status: 'skipped', reason: 'configuration_missing' };
  const intervalMinutes = getShopIntervalMinutes(env, definition);
  const state = await env.DB.prepare('SELECT * FROM shop_sync_state WHERE shop_key = ?').bind(adapter.key).first();
  if (!force && !isShopDue(state, intervalMinutes, now)) return { shopKey: adapter.key, status: 'skipped', reason: 'not_due' };

  const startedAt = nowIso(now);
  await markAttempt(env.DB, adapter.key, startedAt);
  const run = await env.DB.prepare('INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, \'running\')')
    .bind(adapter.key, startedAt).run();
  const runId = run.meta.last_row_id;
  const settings = getCrawlerSettings(env);
  const maxPages = getShopMaxPages(env, definition, settings.maxPagesPerShop);
  const robotsCache = new Map();
  const items = new Map();
  let pageCount = 0;
  let reachedEnd = false;
  let coverageIncomplete = false;
  const browserFetcher = adapter.transport === 'browser' ? createBrowserHtmlFetcher(env.BROWSER) : null;

  try {
    const pageQueue = [...adapter.pageUrls(maxPages, env)];
    const queuedUrls = new Set(pageQueue.map(pageUrl));

    while (pageQueue.length && pageCount < maxPages) {
      const page = pageQueue.shift();
      const url = pageUrl(page);
      let html;
      try {
        const fetchOptions = {
          baseUrl: adapter.baseUrl,
          userAgent: settings.userAgent,
          requestDelayMs: settings.requestDelayMs,
          fetchFn,
          robotsCache
        };
        html = browserFetcher
          ? await browserFetcher.fetchHtmlPage(url, fetchOptions)
          : await fetchHtmlPage(url, fetchOptions);
      } catch (error) {
        // Entry-point 404s are tolerated to let another category/root proceed, but coverage is then incomplete.
        if (/HTTP 404/.test(error.message) && (adapter.continueOnEmpty || items.size === 0)) {
          coverageIncomplete = true;
          continue;
        }
        throw error;
      }

      pageCount += 1;
      const parsed = adapter.parse(html, page);

      if (adapter.dynamicPagination && adapter.discoverPageUrls) {
        const discovered = adapter.discoverPageUrls(html, page);
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
      }

      if (!parsed.length) {
        if (adapter.dynamicPagination) coverageIncomplete = true;
        if (items.size > 0) {
          if (adapter.continueOnEmpty) continue;
          reachedEnd = true;
          break;
        }
      }

      for (const item of parsed) items.set(item.sourceId, item);
    }

    if (pageQueue.length) coverageIncomplete = true;
    if (!items.size) throw new Error('no products parsed; refusing to mark existing products inactive');

    const observedAt = nowIso(new Date());
    const deactivateMissing = reachedEnd || (adapter.dynamicPagination && !coverageIncomplete && pageQueue.length === 0);
    const { changedCount } = await upsertProducts(env.DB, adapter.key, [...items.values()], observedAt, { deactivateMissing });
    await markSuccess(env.DB, adapter.key, observedAt, items.size);
    await env.DB.prepare('UPDATE crawl_runs SET finished_at = ?, status = \'success\', item_count = ?, page_count = ?, message = ? WHERE id = ?')
      .bind(observedAt, items.size, pageCount, `${changedCount} changed`, runId).run();
    return { shopKey: adapter.key, status: 'success', itemCount: items.size, pageCount, changedCount };
  } catch (error) {
    const failedAt = nowIso(new Date());
    await markFailure(env.DB, adapter.key, failedAt, error.message, state?.consecutive_failures || 0);
    await env.DB.prepare('UPDATE crawl_runs SET finished_at = ?, status = \'failed\', page_count = ?, message = ? WHERE id = ?')
      .bind(failedAt, pageCount, String(error.message).slice(0, 1000), runId).run();
    return { shopKey: adapter.key, status: 'failed', error: error.message };
  } finally {
    await browserFetcher?.close();
  }
}

export async function crawlDueShops(env, options = {}) {
  const results = [];
  for (const adapter of SHOP_ADAPTERS) results.push(await crawlShop(env, adapter, options));
  return results;
}

export async function crawlNextDueShop(env, { now = new Date(), fetchFn = fetch } = {}) {
  const statesResult = await env.DB.prepare('SELECT * FROM shop_sync_state').all();
  const states = new Map((statesResult.results || []).map(row => [row.shop_key, row]));
  const candidates = SHOP_ADAPTERS
    .filter(adapter => !adapter.isConfigured || adapter.isConfigured(env))
    .map(adapter => {
      const definition = Object.values(SHOP_DEFINITIONS).find(v => v.key === adapter.key);
      const interval = getShopIntervalMinutes(env, definition);
      const state = states.get(adapter.key);
      return { adapter, state, interval, due: isShopDue(state, interval, now), lastAttempt: state?.last_attempt_at || '' };
    })
    .filter(candidate => candidate.due)
    .sort((a, b) => a.lastAttempt.localeCompare(b.lastAttempt));
  if (!candidates.length) return { status: 'skipped', reason: 'no_shop_due' };
  return crawlShop(env, candidates[0].adapter, { now, fetchFn });
}
