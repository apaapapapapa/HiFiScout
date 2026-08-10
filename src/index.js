import { SHOP_DEFINITIONS, getShopIntervalMinutes } from './config.js';
import { crawlNextDueShop, crawlShop } from './crawler/run.js';
import { SHOP_ADAPTERS } from './crawler/shops/index.js';
import { listProducts, productHistory } from './db/products.js';

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(init.headers || {}) }
  });
}

async function meta(env) {
  const states = await env.DB.prepare('SELECT * FROM shop_sync_state').all();
  const byKey = Object.fromEntries((states.results || []).map(row => [row.shop_key, row]));
  const shops = Object.values(SHOP_DEFINITIONS).map(shop => ({
    key: shop.key,
    name: shop.name,
    intervalMinutes: getShopIntervalMinutes(env, shop),
    sync: byKey[shop.key] || null
  }));
  const facets = await env.DB.batch([
    env.DB.prepare('SELECT DISTINCT manufacturer AS value FROM products WHERE is_active = 1 AND manufacturer <> \'\' ORDER BY manufacturer'),
    env.DB.prepare('SELECT DISTINCT category AS value FROM products WHERE is_active = 1 ORDER BY category')
  ]);
  return { shops, manufacturers: facets[0].results.map(r => r.value), categories: facets[1].results.map(r => r.value) };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/products') return json(await listProducts(env.DB, url));
  if (request.method === 'GET' && url.pathname === '/api/meta') return json(await meta(env));
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true, service: 'HiFiScout' });

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(crawlNextDueShop(env));
  }
};
