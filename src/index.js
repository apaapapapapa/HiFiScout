import { checkPublicApiRateLimit } from './api-guard.js';
import { canonicalCategoryDefinitions, categoryFacet, getCategory } from './catalog/categories.js';
import { KNOWLEDGE_CATALOG_VERIFIER_VERSION } from './catalog/knowledge-source-verifier-v4.js';
import { SHOP_DEFINITIONS, getShopEnabled, getShopIntervalMinutes } from './config.js';
import { consumeCrawlMessage, dispatchDueCrawls, dispatchForcedCrawl, dispatchScheduledCrawl } from './crawler/dispatch.js';
import { knowledgeCatalogOperationalStatus } from './db/knowledge-catalog-review-repository.js';
import {
  claimKnowledgeCatalogVerifierVersion,
  finishKnowledgeCatalogVerifierVersionFailure,
  finishKnowledgeCatalogVerifierVersionSuccess,
  knowledgeCatalogVerifierState
} from './db/knowledge-catalog-verifier-state-repository.js';
import { listProducts, productHistory, validateProductQuery } from './db/products.js';
import { buildSyncHealth, getSyncHealth, logSyncHealth } from './health.js';
import {
  runKnowledgeCatalogDailyVerification,
  runKnowledgeCatalogMonthlyRecheck
} from './knowledge-catalog-review.js';
import { runRetentionCleanup } from './maintenance.js';

const GENERAL_CRON = '*/5 * * * *';
const AUDIOUNION_CRON = '1 * * * *';
const FUJIYA_AVIC_CRON = '30 * * * *';
const RETENTION_CRON = '17 18 * * *';
const KNOWLEDGE_CATALOG_DAILY_CRON = '43 4 * * *';
const KNOWLEDGE_CATALOG_MONTHLY_CRON = '23 3 1 * *';

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

function categorySortKey(category) {
  const parent = category.parentId ? getCategory(category.parentId) : category;
  return [parent?.order || 999, category.parentId ? 1 : 0, category.order || 999];
}

async function meta(env) {
  const states = await env.DB.prepare('SELECT * FROM shop_sync_state').all();
  const stateRows = states.results || [];
  const byKey = Object.fromEntries(stateRows.map(row => [row.shop_key, row]));
  const health = buildSyncHealth(env, stateRows);
  const healthByKey = Object.fromEntries(health.shops.map(shop => [shop.shopKey, shop]));
  const shops = Object.values(SHOP_DEFINITIONS).map(shop => ({
    key: shop.key, name: shop.name, enabled: getShopEnabled(env, shop), intervalMinutes: getShopIntervalMinutes(env, shop), sync: byKey[shop.key] || null, health: healthByKey[shop.key] || null
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
      SELECT pc.category_id AS value, COUNT(DISTINCT pc.product_id) AS active_product_count
      FROM product_categories pc
      JOIN products p ON p.id = pc.product_id
      WHERE p.is_active = 1
      GROUP BY pc.category_id
    `)
  ]);
  const manufacturers = facets[0].results.map(row => row.value);
  const counts = new Map(facets[1].results.map(row => [row.value, Number(row.active_product_count || 0)]));
  const categoryFacets = canonicalCategoryDefinitions()
    .filter(category => category.filterable)
    .map(category => {
      const facet = categoryFacet(category.id);
      return {
        ...facet,
        name: category.parentId ? `　${category.name}` : category.name,
        group: null,
        activeProductCount: counts.get(category.id) || 0
      };
    })
    .sort((left, right) => {
      const a = categorySortKey(left);
      const b = categorySortKey(right);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    });
  const categories = canonicalCategoryDefinitions()
    .filter(category => category.classifiable)
    .map(category => category.name);
  return { status: health.status, shops, manufacturers, categories, categoryFacets };
}

async function knowledgeCatalogStatus(env) {
  const [status, state] = await Promise.all([
    knowledgeCatalogOperationalStatus(env.DB),
    knowledgeCatalogVerifierState(env.DB)
  ]);
  return {
    ...status,
    verifier: {
      expectedVersion: KNOWLEDGE_CATALOG_VERIFIER_VERSION,
      version: state?.version || 0,
      status: state?.status || 'pending',
      startedAt: state?.startedAt || null,
      finishedAt: state?.finishedAt || null,
      message: state?.message || ''
    }
  };
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const rate = await checkPublicApiRateLimit(request, env);
  if (!rate.allowed) return json({ error: 'rate_limited' }, { status: 429 });
  if (request.method === 'GET' && url.pathname === '/api/products') {
    const validationError = validateProductQuery(url);
    if (validationError) return json({ error: validationError }, { status: 400 });
    return cachedJson(request, ctx, 30, () => listProducts(env.DB, url));
  }
  if (request.method === 'GET' && url.pathname === '/api/meta') return cachedJson(request, ctx, 30, () => meta(env));
  if (request.method === 'GET' && url.pathname === '/api/knowledge-catalog/status') {
    return cachedJson(request, ctx, 30, () => knowledgeCatalogStatus(env));
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    try {
      const health = await getSyncHealth(env);
      return json({ service: 'HiFiScout', ...health }, { status: health.ok ? 200 : 503 });
    } catch (error) {
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
    if (!env.ADMIN_TOKEN || request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, { status: 401 });
    const result = await dispatchForcedCrawl(env, url.searchParams.get('shop'));
    if (result.reason === 'unknown_shop') return json({ error: 'unknown_shop' }, { status: 400 });
    if (result.reason === 'disabled') return json({ error: 'disabled' }, { status: 409 });
    return json(result, { status: 202 });
  }
  return json({ error: 'not_found' }, { status: 404 });
}

function logDispatchResult(cron, dispatch) {
  const entry = { event: 'crawl_dispatch', cron, ...dispatch };
  if (dispatch.status === 'rejected' || (dispatch.status === 'skipped' && dispatch.reason)) console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

async function runScheduled(cron, env) {
  if (cron === RETENTION_CRON) return runRetentionCleanup(env);
  if (cron === KNOWLEDGE_CATALOG_DAILY_CRON) return runKnowledgeCatalogDailyVerification(env);
  if (cron === KNOWLEDGE_CATALOG_MONTHLY_CRON) return runKnowledgeCatalogMonthlyRecheck(env);
  const dispatch = cron === AUDIOUNION_CRON
    ? await dispatchScheduledCrawl(env, 'audiounion')
    : cron === FUJIYA_AVIC_CRON
      ? await dispatchScheduledCrawl(env, 'fujiya-avic')
      : await dispatchDueCrawls(env, { excludeShopKeys: ['audiounion', 'fujiya-avic'] });
  logDispatchResult(cron, dispatch);
  const health = await getSyncHealth(env);
  logSyncHealth(health);
  return dispatch;
}

async function bootstrapKnowledgeCatalogReview(env) {
  const now = new Date();
  const startedAt = now.toISOString();
  const claimed = await claimKnowledgeCatalogVerifierVersion(
    env.DB,
    KNOWLEDGE_CATALOG_VERIFIER_VERSION,
    startedAt
  );
  if (!claimed) return { status: 'skipped', reason: 'verifier_version_already_claimed' };

  console.log(JSON.stringify({
    event: 'knowledge_catalog_verifier_rollout_started',
    verifierVersion: KNOWLEDGE_CATALOG_VERIFIER_VERSION,
    mode: 'daily_candidates'
  }));
  try {
    // A verifier rollout immediately exercises the new source behavior against candidate products.
    // Existing verified products keep their independent 30-day recheck cadence.
    const result = await runKnowledgeCatalogDailyVerification(env, { now, preferRetries: false });
    await finishKnowledgeCatalogVerifierVersionSuccess(
      env.DB,
      KNOWLEDGE_CATALOG_VERIFIER_VERSION,
      new Date().toISOString(),
      result.message
    );
    return result;
  } catch (error) {
    await finishKnowledgeCatalogVerifierVersionFailure(
      env.DB,
      KNOWLEDGE_CATALOG_VERIFIER_VERSION,
      new Date().toISOString(),
      error?.message || String(error)
    );
    throw error;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(controller.cron, env));
    if (controller.cron === GENERAL_CRON) ctx.waitUntil(bootstrapKnowledgeCatalogReview(env));
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      const result = await consumeCrawlMessage(env, message.body);
      if (result.status === 'failed') console.error(JSON.stringify({ event: 'crawl_queue_job_failed', ...result }));
      else console.log(JSON.stringify({ event: 'crawl_queue_job_completed', ...result }));
      const health = await getSyncHealth(env);
      logSyncHealth(health);
      message.ack();
    }
  }
};
