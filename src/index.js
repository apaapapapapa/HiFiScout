import { SHOP_DEFINITIONS, getShopEnabled, getShopIntervalMinutes } from './config.js';
import { crawlNextDueShop, crawlShop } from './crawler/run.js';
import { SHOP_ADAPTERS } from './crawler/shops/index.js';
import { listProducts, productHistory } from './db/products.js';
import { buildSyncHealth, getSyncHealth, logSyncHealth } from './health.js';

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
    env.DB.prepare('SELECT DISTINCT manufacturer AS value FROM products WHERE is_active = 1 AND manufacturer <> \'\' ORDER BY manufacturer'),
    env.DB.prepare('SELECT DISTINCT category AS value FROM products WHERE is_active = 1 ORDER BY category')
  ]);
  return { status: health.status, shops, manufacturers: facets[0].results.map(r => r.value), categories: facets[1].results.map(r => r.value) };
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/products') {
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
    const result = await productHistory(env.DB, Number(historyMatch[1]));
    return result ? json(result) : json({ error: 'not_found' }, { status: 404 });
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/crawl') {
    if (!env.ADMIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return json({ error: 'unauthorized' }, { status: 401 });
    }
    const shopKey = url.searchParams.get('shop');
    const adapter = SHOP_ADAPTERS.find(v => v.key === shopKey);
    if (!adapter) return json({ error: 'unknown_shop' }, { status: 400 });
    return json(await crawlShop(env, adapter, { force: true }));
  }

  return json({ error: 'not_found' }, { status: 404 });
}

async function runScheduled(env) {
  const result = await crawlNextDueShop(env);
  const health = await getSyncHealth(env);
  logSyncHealth(health);
  return result;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  }
};
