import { categoryFacet } from './catalog/categories.js';
import { SHOP_DEFINITIONS, getShopEnabled, getShopIntervalMinutes } from './config.js';
import { checkPublicApiRateLimit } from './api-guard.js';
import { consumeCrawlMessage, dispatchDueCrawls, dispatchForcedCrawl, dispatchScheduledCrawl } from './crawler/dispatch.js';
import { listProducts, productHistory, validateProductQuery } from './db/products.js';
import { buildSyncHealth, getSyncHealth, logSyncHealth } from './health.js';
import { runRetentionCleanup } from './maintenance.js';

const AUDIOUNION_CRON = '1 * * * *';
const AUDIOUNION_DIAGNOSTIC_CRON = '* * * * *';
const RETENTION_CRON = '17 18 * * *';

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(init.headers || {}) }
  });
}

async function cachedJson(request, ctx, ttlSeconds, load) {
  const cacheControl = `public, max-age=${ttlSeconds}`;
  if (typeof caches === 'undefined') return json(await load(), { headers: { 'cache-control': cacheControl } });

  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = json(await load(), { headers: { 'cache-control': cacheControl } });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function meta(env) {
  const states = await env.DB.prepare('SELECT * FROM shop_sync_state').all();
  const stateRows = states.results || [];
  const byKey = Object.fromEntries(stateRows.map(row => [row.shop_key, row]));
  const health = buildSyncHealth(env, stateRows);
  const healthByKey = Object.fromEntries(health.shops.map(shop => [shop.shopKey, shop]));
  const shops = Object.values(SHOP_DEFINITIONS).map(shop => ({
    key: shop.key,
    name: shop.name,
    enabled: getShopEnabled(env, shop),
    intervalMinutes: getShopIntervalMinutes(env, shop),
    sync: byKey[shop.key] || null,
    health: healthByKey[shop.key] || null
  }));
  const facets = await env.DB.batch([
    env.DB.prepare(`
      SELECT manufacturer_id, MIN(manufacturer) AS value
      FROM products
      WHERE is_active = 1 AND manufacturer <> ''
      GROUP BY manufacturer_id
      ORDER BY value
    `),
    env.DB.prepare(`
      SELECT DISTINCT pc.category_id AS value
      FROM product_categories pc
      JOIN products p ON p.id = pc.product_id
      WHERE p.is_active = 1
    `)
  ]);
  const manufacturers = facets[0].results.map(row => row.value);
  const categoryFacets = facets[1].results
    .map(row => categoryFacet(row.value))
    .filter(Boolean)
    .sort((left, right) => {
      const groupOrder = ['アンプ', 'デジタル', 'アナログ'];
      const leftGroup = left.group ? groupOrder.indexOf(left.group) : -1;
      const rightGroup = right.group ? groupOrder.indexOf(right.group) : -1;
      if (leftGroup !== rightGroup) return leftGroup - rightGroup;
      return left.name.localeCompare(right.name, 'ja');
    });
  const categories = categoryFacets.map(category => category.name);
  return { status: health.status, shops, manufacturers, categories, categoryFacets };
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const rate = await checkPublicApiRateLimit(request, env);
  if (!rate.allowed) {
    console.warn(JSON.stringify({ event: 'api_rate_limited', bucket: rate.bucket }));
    return json({ error: 'rate_limited' }, { status: 429 });
  }

  if (request.method === 'GET' && url.pathname === '/api/products') {
    const validationError = validateProductQuery(url);
    if (validationError) return json({ error: validationError }, { status: 400 });
    return cachedJson(request, ctx, 30, () => listProducts(env.DB, url));
  }
  if (request.method === 'GET' && url.pathname === '/api/meta') {
    return cachedJson(request, ctx, 30, () => meta(env));
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    try {
      const health = await getSyncHealth(env);
      return json({ service: 'HiFiScout', ...health }, { status: health.ok ? 200 : 503 });
    } catch (error) {
      console.error(JSON.stringify({ event: 'sync_health_check_failed', error: error instanceof Error ? error.message : String(error) }));
      return json({ ok: false, service: 'HiFiScout', status: 'critical', error: 'health_check_failed' }, { status: 503 });
    }
  }

  const historyMatch = url.pathname.match(/^\/api\/products\/(\d+)\/history$/);
  if (request.method === 'GET' && historyMatch) {
    const id = Number(historyMatch[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: 'invalid_id' }, { status: 400 });
    const result = await productHistory(env.DB, id);
    return result ? json(result) : json({ error: 'not_found' }, { status: 404 });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/crawl') {
    if (!env.ADMIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return json({ error: 'unauthorized' }, { status: 401 });
    }
    const result = await dispatchForcedCrawl(env, url.searchParams.get('shop'));
    if (result.reason === 'unknown_shop') return json({ error: 'unknown_shop' }, { status: 400 });
    if (result.reason === 'disabled') return json({ error: 'disabled' }, { status: 409 });
    return json(result, { status: 202 });
  }

  return json({ error: 'not_found' }, { status: 404 });
}

function logDispatchResult(cron, dispatch) {
  const entry = { event: 'crawl_dispatch', cron, ...dispatch };
  if (dispatch.status === 'rejected' || (dispatch.status === 'skipped' && dispatch.reason)) {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

async function runScheduled(cron, env) {
  if (cron === RETENTION_CRON) return runRetentionCleanup(env);
  const dispatch = (cron === AUDIOUNION_CRON || cron === AUDIOUNION_DIAGNOSTIC_CRON)
    ? await dispatchScheduledCrawl(env, 'audiounion')
    : await dispatchDueCrawls(env, { excludeShopKeys: ['audiounion'] });
  logDispatchResult(cron, dispatch);
  const health = await getSyncHealth(env);
  logSyncHealth(health);
  return dispatch;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const result = await consumeCrawlMessage(env, message.body);
      if (result.status === 'failed') {
        console.error(JSON.stringify({ event: 'crawl_queue_job_failed', ...result }));
      } else {
        console.log(JSON.stringify({ event: 'crawl_queue_job_completed', ...result }));
      }
      const health = await getSyncHealth(env);
      logSyncHealth(health);
      message.ack();
    }
  }
};
