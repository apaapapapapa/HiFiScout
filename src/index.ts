import { checkPublicApiRateLimit } from "./api-guard.js";
import { canonicalCategoryDefinitions, getCategory } from "./catalog/categories.js";
import { KNOWLEDGE_CATALOG_VERIFIER_VERSION } from "./catalog/knowledge-source-verifier-v4.js";
import { SHOP_DEFINITIONS, getShopEnabled, getShopIntervalMinutes } from "./config.js";
import {
  consumeCrawlMessage,
  dispatchDueCrawls,
  dispatchForcedCrawl,
  dispatchScheduledCrawl,
} from "./crawler/dispatch.js";
import { dataQualityStatus, listDataQualityHistory } from "./db/data-quality-repository.js";
import { dataPlatformStatus } from "./db/data-platform-status-repository.js";
import { knowledgeCatalogOperationalStatus } from "./db/knowledge-catalog-review-repository.js";
import { knowledgeCatalogVerificationQueueStatus } from "./db/knowledge-catalog-verification-queue-repository.js";
import {
  claimKnowledgeCatalogVerifierVersion,
  knowledgeCatalogVerifierState,
} from "./db/knowledge-catalog-verifier-state-repository.js";
import { parseProductQuery, validateProductQuery } from "./api/product-query.js";
import { productHistory } from "./db/product-history-repository.js";
import { listProducts } from "./db/product-search-repository.js";
import { buildSyncHealth, getSyncHealth, logSyncHealth } from "./health.js";
import {
  KNOWLEDGE_CATALOG_VERIFICATION_DLQ,
  KNOWLEDGE_CATALOG_VERIFICATION_QUEUE,
  consumeKnowledgeCatalogVerificationBatch,
  consumeKnowledgeCatalogVerificationDeadLetterBatch,
  dispatchKnowledgeCatalogDailyVerification,
  dispatchKnowledgeCatalogMonthlyRecheck,
} from "./knowledge-catalog-verification-queue.js";
import { runRetentionCleanup } from "./maintenance.js";
import { errorMessage, isRecord } from "./types.js";
import type {
  MetaCategoryFacet,
  MetaResponse,
  MetaShop,
  MetaShopSyncState,
} from "./api/contracts.js";
import type { CategoryDefinition } from "./catalog/types.js";
import type {
  CrawlQueueMessage,
  CrawlerEnv,
  DispatchResult,
  KnowledgeCatalogQueueMessage,
} from "./crawler/types.js";
import type { ShopSyncStateRow } from "./db/types.js";

const GENERAL_CRON = "*/5 * * * *";
const AUDIOUNION_CRON = "1 * * * *";
const FUJIYA_AVIC_CRON = "30 * * * *";
const DAILY_MAINTENANCE_CRON = "17 18 * * *";
const KNOWLEDGE_CATALOG_MONTHLY_CRON = "23 3 1 * *";
const CRAWL_QUEUE = "hifiscout-crawl";

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

async function cachedJson(
  request: Request,
  ctx: ExecutionContext,
  ttlSeconds: number,
  load: () => unknown | Promise<unknown>,
): Promise<Response> {
  const cacheControl = `public, max-age=${ttlSeconds}`;
  if (typeof caches === "undefined")
    return json(await load(), { headers: { "cache-control": cacheControl } });
  const cache = (caches as CacheStorage & { readonly default: Cache }).default;
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = json(await load(), { headers: { "cache-control": cacheControl } });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

function categorySortKey(category: Pick<CategoryDefinition, "parentId" | "order">): number[] {
  const parent = category.parentId ? getCategory(category.parentId) : category;
  return [parent?.order || 999, category.parentId ? 1 : 0, category.order || 999];
}

interface MetaFacetRow {
  manufacturer_id?: string;
  value: string;
  active_product_count?: number | null;
}

/** Explicit row -> contract projection: `shop_sync_state` must not define the payload by itself. */
function toMetaShopSyncState(row: ShopSyncStateRow): MetaShopSyncState {
  return {
    shop_key: row.shop_key,
    last_attempt_at: row.last_attempt_at,
    last_success_at: row.last_success_at,
    last_error_at: row.last_error_at,
    consecutive_failures: row.consecutive_failures,
    backoff_until: row.backoff_until,
    last_error: row.last_error,
    last_item_count: row.last_item_count,
    queued_at: row.queued_at,
  };
}

async function meta(env: Env): Promise<MetaResponse> {
  const states = await env.DB.prepare("SELECT * FROM shop_sync_state").all<ShopSyncStateRow>();
  const stateRows = states.results || [];
  const byKey = new Map(stateRows.map((row) => [row.shop_key, toMetaShopSyncState(row)]));
  const health = buildSyncHealth(env, stateRows);
  const healthByKey = new Map(health.shops.map((shop) => [shop.shopKey, shop]));
  const shops = Object.values(SHOP_DEFINITIONS).map((shop): MetaShop => ({
    key: shop.key,
    name: shop.name,
    enabled: getShopEnabled(env, shop),
    intervalMinutes: getShopIntervalMinutes(env, shop),
    sync: byKey.get(shop.key) || null,
    health: healthByKey.get(shop.key) || null,
  }));
  const facets = await env.DB.batch<MetaFacetRow>([
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
    `),
  ]);
  const manufacturers = (facets[0]?.results || []).map((row) => row.value);
  const counts = new Map(
    (facets[1]?.results || []).map((row): [string, number] => [
      row.value,
      Number(row.active_product_count || 0),
    ]),
  );
  const categoryFacets = canonicalCategoryDefinitions()
    .filter((category) => category.filterable)
    .sort((left, right) => {
      const a = categorySortKey(left);
      const b = categorySortKey(right);
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    })
    .map((category): MetaCategoryFacet => {
      return {
        id: category.id,
        parentId: category.parentId,
        order: category.order,
        classifiable: category.classifiable,
        filterable: category.filterable,
        name: category.parentId ? `　${category.name}` : category.name,
        group: null,
        activeProductCount: counts.get(category.id) || 0,
      };
    });
  const categories = canonicalCategoryDefinitions()
    .filter((category) => category.classifiable)
    .map((category) => category.name);
  return { status: health.status, shops, manufacturers, categories, categoryFacets };
}

async function knowledgeCatalogStatus(env: Env) {
  const [status, state, queue] = await Promise.all([
    knowledgeCatalogOperationalStatus(env.DB),
    knowledgeCatalogVerifierState(env.DB),
    knowledgeCatalogVerificationQueueStatus(env.DB),
  ]);
  return {
    ...status,
    queue,
    verifier: {
      expectedVersion: KNOWLEDGE_CATALOG_VERIFIER_VERSION,
      version: state?.version || 0,
      status: state?.status || "pending",
      startedAt: state?.startedAt || null,
      finishedAt: state?.finishedAt || null,
      message: state?.message || "",
    },
  };
}

function adminAuthorized(request: Request, env: CrawlerEnv): boolean {
  return Boolean(
    env.ADMIN_TOKEN && request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`,
  );
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const rate = await checkPublicApiRateLimit(request, env);
  if (!rate.allowed) return json({ error: "rate_limited" }, { status: 429 });
  if (request.method === "GET" && url.pathname === "/api/products") {
    const validationError = validateProductQuery(url);
    if (validationError) return json({ error: validationError }, { status: 400 });
    const query = parseProductQuery(url);
    return cachedJson(request, ctx, 30, () => listProducts(env.DB, query));
  }
  if (request.method === "GET" && url.pathname === "/api/meta")
    return cachedJson(request, ctx, 30, () => meta(env));
  if (request.method === "GET" && url.pathname === "/api/knowledge-catalog/status") {
    return cachedJson(request, ctx, 30, () => knowledgeCatalogStatus(env));
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    try {
      const health = await getSyncHealth(env);
      return json({ service: "HiFiScout", ...health }, { status: health.ok ? 200 : 503 });
    } catch {
      return json(
        { ok: false, service: "HiFiScout", status: "critical", error: "health_check_failed" },
        { status: 503 },
      );
    }
  }
  if (request.method === "GET" && url.pathname === "/api/admin/data-platform/status") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    return json(await dataPlatformStatus(env.DB));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/data-quality/status") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    return json(await dataQualityStatus(env.DB));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/data-quality/history") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const shop = String(url.searchParams.get("shop") || "").trim();
    if (!shop || !SHOP_DEFINITIONS[shop]) return json({ error: "invalid_shop" }, { status: 400 });
    const history = await listDataQualityHistory(
      env.DB,
      shop,
      Number(url.searchParams.get("limit")) || undefined,
    );
    return json({ shop, history });
  }
  const historyMatch = url.pathname.match(/^\/api\/products\/(\d+)\/history$/);
  if (request.method === "GET" && historyMatch) {
    const id = Number(historyMatch[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "invalid_id" }, { status: 400 });
    const result = await productHistory(env.DB, id);
    return result ? json(result) : json({ error: "not_found" }, { status: 404 });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/crawl") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const result = await dispatchForcedCrawl(env, url.searchParams.get("shop"));
    if (result.status === "rejected" && result.reason === "unknown_shop")
      return json({ error: "unknown_shop" }, { status: 400 });
    if (result.status === "rejected" && result.reason === "disabled")
      return json({ error: "disabled" }, { status: 409 });
    return json(result, { status: 202 });
  }
  return json({ error: "not_found" }, { status: 404 });
}

function logDispatchResult(cron: string, dispatch: DispatchResult): void {
  const entry = { event: "crawl_dispatch", cron, ...dispatch };
  if (dispatch.status === "rejected" || (dispatch.status === "skipped" && "reason" in dispatch))
    console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

async function runDailyMaintenance(env: Env) {
  const [retention, catalog] = await Promise.allSettled([
    runRetentionCleanup(env),
    dispatchKnowledgeCatalogDailyVerification(env),
  ]);
  if (retention.status === "rejected") {
    console.error(
      JSON.stringify({
        event: "daily_retention_failed",
        message: errorMessage(retention.reason),
      }),
    );
  }
  if (catalog.status === "rejected") {
    console.error(
      JSON.stringify({
        event: "knowledge_catalog_daily_dispatch_failed",
        message: errorMessage(catalog.reason),
      }),
    );
  }
  if (retention.status === "rejected") throw retention.reason;
  if (catalog.status === "rejected") throw catalog.reason;
  return { retention: retention.value, catalog: catalog.value };
}

async function runScheduled(cron: string, env: Env) {
  if (cron === DAILY_MAINTENANCE_CRON) return runDailyMaintenance(env);
  if (cron === KNOWLEDGE_CATALOG_MONTHLY_CRON) return dispatchKnowledgeCatalogMonthlyRecheck(env);
  const dispatch =
    cron === AUDIOUNION_CRON
      ? await dispatchScheduledCrawl(env, "audiounion")
      : cron === FUJIYA_AVIC_CRON
        ? await dispatchScheduledCrawl(env, "fujiya-avic")
        : await dispatchDueCrawls(env, { excludeShopKeys: ["audiounion", "fujiya-avic"] });
  logDispatchResult(cron, dispatch);
  const health = await getSyncHealth(env);
  logSyncHealth(health);
  return dispatch;
}

async function bootstrapKnowledgeCatalogReview(env: Env) {
  const now = new Date();
  const startedAt = now.toISOString();
  const claimed = await claimKnowledgeCatalogVerifierVersion(
    env.DB,
    KNOWLEDGE_CATALOG_VERIFIER_VERSION,
    startedAt,
  );
  if (claimed) {
    console.log(
      JSON.stringify({
        event: "knowledge_catalog_verifier_rollout_started",
        verifierVersion: KNOWLEDGE_CATALOG_VERIFIER_VERSION,
        mode: "daily_candidates_queue",
      }),
    );
    return dispatchKnowledgeCatalogDailyVerification(env, {
      now,
      preferRetries: false,
      verifierVersion: KNOWLEDGE_CATALOG_VERIFIER_VERSION,
    });
  }

  const [state, queue] = await Promise.all([
    knowledgeCatalogVerifierState(env.DB),
    knowledgeCatalogVerificationQueueStatus(env.DB),
  ]);
  if (queue.latestRunId) {
    return { status: "skipped", reason: "knowledge_catalog_queue_already_bootstrapped" };
  }

  const verifierVersion =
    state?.version === KNOWLEDGE_CATALOG_VERIFIER_VERSION && state.status !== "success"
      ? KNOWLEDGE_CATALOG_VERIFIER_VERSION
      : 0;
  console.log(
    JSON.stringify({
      event: "knowledge_catalog_queue_rollout_started",
      verifierVersion,
      mode: "daily_candidates_queue",
    }),
  );
  return dispatchKnowledgeCatalogDailyVerification(env, {
    now,
    preferRetries: false,
    verifierVersion,
  });
}

async function consumeCrawlBatch(batch: MessageBatch<CrawlQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const result = await consumeCrawlMessage(env, message.body);
    if (result.status === "failed")
      console.error(JSON.stringify({ event: "crawl_queue_job_failed", ...result }));
    else console.log(JSON.stringify({ event: "crawl_queue_job_completed", ...result }));
    const health = await getSyncHealth(env);
    logSyncHealth(health);
    message.ack();
  }
}

type WorkerQueueMessage = CrawlQueueMessage | KnowledgeCatalogQueueMessage;

function isCrawlBatch(
  batch: MessageBatch<WorkerQueueMessage>,
): batch is MessageBatch<CrawlQueueMessage> {
  return batch.messages.every((message) => isRecord(message.body) && "shopKey" in message.body);
}

function isKnowledgeCatalogBatch(
  batch: MessageBatch<WorkerQueueMessage>,
): batch is MessageBatch<KnowledgeCatalogQueueMessage> {
  return batch.messages.every((message) => isRecord(message.body) && "jobId" in message.body);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(controller.cron, env));
    if (controller.cron === GENERAL_CRON) ctx.waitUntil(bootstrapKnowledgeCatalogReview(env));
  },
  async queue(batch: MessageBatch<WorkerQueueMessage>, env: Env): Promise<void> {
    if (batch.queue === KNOWLEDGE_CATALOG_VERIFICATION_QUEUE && isKnowledgeCatalogBatch(batch)) {
      return consumeKnowledgeCatalogVerificationBatch(env, batch);
    }
    if (batch.queue === KNOWLEDGE_CATALOG_VERIFICATION_DLQ && isKnowledgeCatalogBatch(batch)) {
      return consumeKnowledgeCatalogVerificationDeadLetterBatch(env, batch);
    }
    if (batch.queue === CRAWL_QUEUE && isCrawlBatch(batch)) return consumeCrawlBatch(batch, env);

    console.error(JSON.stringify({ event: "unknown_queue", queue: batch.queue }));
    for (const message of batch.messages) message.retry();
  },
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
