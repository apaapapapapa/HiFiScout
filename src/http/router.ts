/**
 * HTTP routing for the Worker.
 *
 * Every `/api/` request passes the public rate limiter first; admin routes additionally require a
 * bearer token. Read endpoints go through the edge cache, writes never do.
 *
 * Anything not under `/api/` is a static asset and is handed to the ASSETS binding.
 */

import { checkPublicApiRateLimit } from "../api-guard.js";
import { parseProductQuery, validateProductQuery } from "../api/product-query.js";
import { SHOP_DEFINITIONS } from "../config.js";
import { dispatchForcedCrawl } from "../crawler/dispatch.js";
import { dataPlatformStatus } from "../db/data-platform-status-repository.js";
import { dataQualityStatus, listDataQualityHistory } from "../db/data-quality-repository.js";
import { productHistory } from "../db/product-history-repository.js";
import { listProducts } from "../db/product-search-repository.js";
import { getSyncHealth } from "../health.js";
import { knowledgeCatalogStatus } from "./knowledge-catalog-status.js";
import { meta } from "./meta.js";
import { cachedJson, json } from "./response.js";
import type { CrawlerEnv } from "../crawler/types.js";

/** Seconds the edge may serve a cached read response. */
const READ_CACHE_TTL_SECONDS = 30;

const PRODUCT_HISTORY_PATH = /^\/api\/products\/(\d+)\/history$/;

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
    // Validate before parsing so a hostile query is rejected rather than silently normalized.
    const validationError = validateProductQuery(url);
    if (validationError) return json({ error: validationError }, { status: 400 });
    const query = parseProductQuery(url);
    return cachedJson(request, ctx, READ_CACHE_TTL_SECONDS, () => listProducts(env.DB, query));
  }
  if (request.method === "GET" && url.pathname === "/api/meta") {
    return cachedJson(request, ctx, READ_CACHE_TTL_SECONDS, () => meta(env));
  }
  if (request.method === "GET" && url.pathname === "/api/knowledge-catalog/status") {
    return cachedJson(request, ctx, READ_CACHE_TTL_SECONDS, () => knowledgeCatalogStatus(env));
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    // A failing health check must still answer 503 rather than surfacing a 500.
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
  const historyMatch = url.pathname.match(PRODUCT_HISTORY_PATH);
  if (request.method === "GET" && historyMatch) {
    const id = Number(historyMatch[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "invalid_id" }, { status: 400 });
    const result = await productHistory(env.DB, id);
    return result ? json(result) : json({ error: "not_found" }, { status: 404 });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/crawl") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const result = await dispatchForcedCrawl(env, url.searchParams.get("shop"));
    if (result.status === "rejected" && result.reason === "unknown_shop") {
      return json({ error: "unknown_shop" }, { status: 400 });
    }
    if (result.status === "rejected" && result.reason === "disabled") {
      return json({ error: "disabled" }, { status: 409 });
    }
    return json(result, { status: 202 });
  }
  return json({ error: "not_found" }, { status: 404 });
}

export async function handleHttp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
  return env.ASSETS.fetch(request);
}
