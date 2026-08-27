/**
 * HTTP routing for the Worker.
 *
 * Every `/api/` request passes the public rate limiter first; admin routes additionally require a
 * bearer token. Read endpoints go through the edge cache, writes never do.
 *
 * Anything not under `/api/` is a static asset and is handed to the ASSETS binding.
 */

import { checkPublicApiRateLimit } from "../api-guard.js";
import { productSearchAtomFeed } from "../api/atom-feed.js";
import { canonicalFeedQueryUrl, parseFeedQuery, validateFeedQuery } from "../api/feed-query.js";
import { parseProductQuery, validateProductQuery } from "../api/product-query.js";
import {
  canonicalSuggestQueryUrl,
  parseSuggestQuery,
  validateSuggestQuery,
} from "../api/suggest-query.js";
import { SHOP_DEFINITIONS } from "../config.js";
import { dispatchForcedCrawl } from "../crawler/dispatch.js";
import { dataPlatformStatus } from "../db/data-platform-status-repository.js";
import {
  dataQualityStatusWithRemediationSlo,
  listDataQualityHistoryWithRemediationSlo,
} from "../db/data-quality-remediation-governance-repository.js";
import { dataQualityRemediationImpact } from "../db/data-quality-remediation-impact-repository.js";
import { enqueueFullDataQualityRebuild } from "../db/data-quality-remediation-queue-repository.js";
import {
  listUnresolvedIdentityGroups,
  reprocessVerifiedCatalogProduct,
} from "../db/knowledge-catalog-remediation-repository.js";
import {
  listUnresolvedManufacturerGroups,
  reprocessStaleManufacturerListings,
  saveManufacturerAliasAndReprocess,
} from "../db/manufacturer-repository.js";
import { listUnresolvedModelGroups, reprocessStaleModelListings } from "../db/model-repository.js";
import { listRecentRemediationEvents } from "../db/remediation-event-repository.js";
import { productHistory } from "../db/product-history-repository.js";
import {
  productSearchEntityConsistency,
  rebuildProductSearchEntities,
} from "../db/product-search-entity-repository.js";
import {
  productSearchDetail,
  searchProducts,
} from "../db/product-search-price-index-repository.js";
import { suggestProducts } from "../db/product-suggest-repository.js";
import { getSyncHealth } from "../health.js";
import { knowledgeCatalogStatus } from "./knowledge-catalog-status.js";
import { parseManufacturerAliasAdminRequest } from "./manufacturer-alias-admin.js";
import {
  DATA_QUALITY_REBUILD_ORDER,
  parseCatalogReplayRequest,
  parseDataQualityRebuildRequest,
  parseReplayRequest,
} from "./remediation-admin.js";
import { meta } from "./meta.js";
import { cachedAtom, cachedJson, json } from "./response.js";
import type { CrawlerEnv } from "../crawler/types.js";

/** Seconds the edge may serve a cached read response. */
const READ_CACHE_TTL_SECONDS = 30;
/** Feed readers poll on their own cadence; a longer window avoids needless D1 reads. */
const FEED_CACHE_TTL_SECONDS = 120;

/** Seller-listing price history. Listing-scoped by design; product search lives elsewhere. */
const PRODUCT_HISTORY_PATH = /^\/api\/products\/(\d+)\/history$/;

/** Namespaced entity key (`c-12`, `l-345`), not a bare id — see `api/product-search-key.ts`. */
const PRODUCT_SEARCH_DETAIL_PATH = /^\/api\/product-search\/([a-z]-\d{1,15})$/;

function adminAuthorized(request: Request, env: CrawlerEnv): boolean {
  return Boolean(
    env.ADMIN_TOKEN && request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`,
  );
}

/** `undefined` for an absent body, `null` for malformed JSON — the parsers distinguish them. */
async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const rate = await checkPublicApiRateLimit(request, env);
  if (!rate.allowed) return json({ error: "rate_limited" }, { status: 429 });

  if (request.method === "GET" && url.pathname === "/api/suggest") {
    const validationError = validateSuggestQuery(url);
    if (validationError) return json({ error: validationError }, { status: 400 });
    const query = parseSuggestQuery(url);
    const cacheRequest = new Request(canonicalSuggestQueryUrl(url, query).toString(), request);
    return cachedJson(cacheRequest, ctx, READ_CACHE_TTL_SECONDS, async () => ({
      suggestions: await suggestProducts(env.DB, query.q),
    }));
  }
  if (request.method === "GET" && url.pathname === "/api/feed") {
    const validationError = validateFeedQuery(url);
    if (validationError) return json({ error: validationError }, { status: 400 });
    const query = parseFeedQuery(url);
    const canonicalUrl = canonicalFeedQueryUrl(url, query);
    const cacheRequest = new Request(canonicalUrl.toString(), request);
    return cachedAtom(cacheRequest, ctx, FEED_CACHE_TTL_SECONDS, async () => {
      const result = await searchProducts(env.DB, query);
      return productSearchAtomFeed(result.items, canonicalUrl);
    });
  }
  if (request.method === "GET" && url.pathname === "/api/product-search") {
    // Validate before parsing so a hostile query is rejected rather than silently normalized.
    const validationError = validateProductQuery(url);
    if (validationError) return json({ error: validationError }, { status: 400 });
    const query = parseProductQuery(url);
    return cachedJson(request, ctx, READ_CACHE_TTL_SECONDS, () => searchProducts(env.DB, query));
  }
  const detailMatch = url.pathname.match(PRODUCT_SEARCH_DETAIL_PATH);
  if (request.method === "GET" && detailMatch) {
    const detail = await productSearchDetail(env.DB, detailMatch[1]);
    return detail ? json(detail) : json({ error: "not_found" }, { status: 404 });
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
    return json(await dataQualityStatusWithRemediationSlo(env.DB));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/data-quality/history") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const shop = String(url.searchParams.get("shop") || "").trim();
    if (!shop || !SHOP_DEFINITIONS[shop]) return json({ error: "invalid_shop" }, { status: 400 });
    const history = await listDataQualityHistoryWithRemediationSlo(
      env.DB,
      shop,
      Number(url.searchParams.get("limit")) || undefined,
    );
    return json({ shop, history });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/data-quality/remediation-impact") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    return json(
      await dataQualityRemediationImpact(
        env.DB,
        Number(url.searchParams.get("limit")) || undefined,
      ),
    );
  }
  if (request.method === "POST" && url.pathname === "/api/admin/data-quality/rebuild") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJsonBody(request);
    if (body === null) return json({ error: "invalid_json" }, { status: 400 });
    const parsed = parseDataQualityRebuildRequest(body);
    if (!parsed) return json({ error: "invalid_rebuild_request" }, { status: 400 });
    const rebuildKey = parsed.rebuildKey ?? "post-phase4-data-quality-remediation-13-15";
    const result = await enqueueFullDataQualityRebuild(env.DB, {
      ...parsed,
      rebuildKey,
      reason: "post_phase4_data_quality_backfill",
      source: "admin_api",
    });
    return json({ order: DATA_QUALITY_REBUILD_ORDER, rebuildKey, ...result }, { status: 202 });
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/admin/data-quality/unresolved-manufacturers"
  ) {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const groups = await listUnresolvedManufacturerGroups(
      env.DB,
      Number(url.searchParams.get("limit")) || undefined,
    );
    return json({ groups });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/manufacturer-aliases") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJsonBody(request);
    if (body === null) return json({ error: "invalid_json" }, { status: 400 });
    const parsed = parseManufacturerAliasAdminRequest(body);
    if (!parsed) return json({ error: "invalid_manufacturer_alias" }, { status: 400 });
    return json(await saveManufacturerAliasAndReprocess(env.DB, parsed.input, parsed.replay));
  }
  if (request.method === "GET" && url.pathname === "/api/admin/data-quality/unresolved-models") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const groups = await listUnresolvedModelGroups(
      env.DB,
      Number(url.searchParams.get("limit")) || undefined,
    );
    return json({ groups });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/data-quality/unresolved-identity") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const groups = await listUnresolvedIdentityGroups(
      env.DB,
      Number(url.searchParams.get("limit")) || undefined,
    );
    return json({ groups });
  }
  if (request.method === "GET" && url.pathname === "/api/admin/data-quality/remediation-events") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const events = await listRecentRemediationEvents(
      env.DB,
      Number(url.searchParams.get("limit")) || undefined,
    );
    return json({ events });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/data-quality/replay-models") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const replay = parseReplayRequest(await readJsonBody(request));
    if (!replay) return json({ error: "invalid_replay_request" }, { status: 400 });
    return json(await reprocessStaleModelListings(env.DB, replay));
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/admin/data-quality/replay-manufacturers"
  ) {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const replay = parseReplayRequest(await readJsonBody(request));
    if (!replay) return json({ error: "invalid_replay_request" }, { status: 400 });
    return json(await reprocessStaleManufacturerListings(env.DB, replay));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/knowledge-catalog/replay") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const parsed = parseCatalogReplayRequest(await readJsonBody(request));
    if (!parsed) return json({ error: "invalid_replay_request" }, { status: 400 });
    const result = await reprocessVerifiedCatalogProduct(
      env.DB,
      parsed.catalogProductId,
      parsed.replay,
    );
    if (!result.target)
      return json({ error: "verified_catalog_product_not_found" }, { status: 404 });
    return json(result);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/product-search/consistency") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    const consistency = await productSearchEntityConsistency(env.DB);
    return json(consistency, { status: consistency.ok ? 200 : 409 });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/product-search/rebuild") {
    if (!adminAuthorized(request, env)) return json({ error: "unauthorized" }, { status: 401 });
    return json(await rebuildProductSearchEntities(env.DB));
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
