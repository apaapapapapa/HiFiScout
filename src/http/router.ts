/**
 * HTTP routing for the Worker.
 *
 * Public API reads pass the rate limiter; cacheable endpoints can use an existing edge entry
 * when the limiter is unavailable. Retired admin paths return 404 without accessing bindings.
 *
 * Anything not under `/api/` is a static asset and is handed to the ASSETS binding.
 */

import { checkPublicApiRateLimit } from "../api-guard.js";
import { productSearchAtomFeed } from "../api/atom-feed.js";
import { canonicalFeedQueryUrl, parseFeedQuery, validateFeedQuery } from "../api/feed-query.js";
import { productHistory } from "../db/product-history-repository.js";
import { productSearchDetail } from "../db/product-search-price-index-repository.js";
import { searchProducts as searchBaseProducts } from "../db/product-search-repository.js";
import { getSyncHealth } from "../health.js";
import { knowledgeCatalogStatus } from "./knowledge-catalog-status.js";
import { meta } from "./meta.js";
import { handlePublicContractRoute } from "./public-routes.js";
import {
  cachedAtom,
  cachedJson,
  json,
  rateLimitedResponse,
  rateLimiterUnavailableResponse,
} from "./response.js";

/** Seconds the edge may serve a cached read response. */
const READ_CACHE_TTL_SECONDS = 30;
/** Feed readers poll on their own cadence; a longer window avoids needless D1 reads. */
const FEED_CACHE_TTL_SECONDS = 120;

/** Seller-listing price history. Listing-scoped by design; product search lives elsewhere. */
const PRODUCT_HISTORY_PATH = /^\/api\/products\/(\d+)\/history$/;

/** Namespaced entity key (`c-12`, `l-345`), not a bare id — see `api/product-search-key.ts`. */
const PRODUCT_SEARCH_DETAIL_PATH = /^\/api\/product-search\/([a-z]-\d{1,15})$/;

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const rate = await checkPublicApiRateLimit(request, env);
  if (rate.decision === "limited") return rateLimitedResponse();
  // The limiter could not decide. Reads an existing cache entry already answers stay available;
  // every other route refuses rather than reaching D1 with no limit in force.
  const cacheOnly = rate.decision === "unavailable";

  const contractResponse = await handlePublicContractRoute(request, env, ctx, { cacheOnly });
  if (contractResponse) return contractResponse;

  if (request.method === "GET" && url.pathname === "/api/feed") {
    const validationError = validateFeedQuery(url);
    if (validationError) return json({ error: validationError }, { status: 400 });
    const query = parseFeedQuery(url);
    const canonicalUrl = canonicalFeedQueryUrl(url, query);
    const cacheRequest = new Request(canonicalUrl.toString(), request);
    return cachedAtom(
      cacheRequest,
      ctx,
      FEED_CACHE_TTL_SECONDS,
      async () => {
        const result = await searchBaseProducts(env.DB, query);
        return productSearchAtomFeed(result.items, canonicalUrl);
      },
      { cacheOnly },
    );
  }
  if (request.method === "GET" && url.pathname === "/api/meta") {
    return cachedJson(request, ctx, READ_CACHE_TTL_SECONDS, () => meta(env), { cacheOnly });
  }
  if (request.method === "GET" && url.pathname === "/api/knowledge-catalog/status") {
    return cachedJson(request, ctx, READ_CACHE_TTL_SECONDS, () => knowledgeCatalogStatus(env), {
      cacheOnly,
    });
  }

  // Past this point every public route either reads D1 or is an unrecognized path, and none of them
  // has a cache entry to fall back on.
  if (cacheOnly) return rateLimiterUnavailableResponse();

  const detailMatch = url.pathname.match(PRODUCT_SEARCH_DETAIL_PATH);
  if (request.method === "GET" && detailMatch) {
    const detail = await productSearchDetail(env.DB, detailMatch[1]);
    return detail ? json(detail) : json({ error: "not_found" }, { status: 404 });
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
  const historyMatch = url.pathname.match(PRODUCT_HISTORY_PATH);
  if (request.method === "GET" && historyMatch) {
    const id = Number(historyMatch[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "invalid_id" }, { status: 400 });
    const result = await productHistory(env.DB, id);
    return result ? json(result) : json({ error: "not_found" }, { status: 404 });
  }
  return json({ error: "not_found" }, { status: 404 });
}

export async function handleHttp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/admin/")) return json({ error: "not_found" }, { status: 404 });
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, ctx);
  return env.ASSETS.fetch(request);
}
