import {
  canonicalSuggestQueryUrl,
  parseSuggestQuery,
  validateSuggestQuery,
} from "../api/suggest-query.js";
import {
  canonicalProductQueryUrl,
  parseProductQuery,
  validateProductQuery,
} from "../api/product-query.js";
import { LEGACY_CATEGORY_MIGRATION_RULES, TAXONOMY_VERSION } from "../catalog/categories.js";
import { PRODUCT_SEARCH_ROUTE, SUGGEST_ROUTE } from "../api/public-route-contracts.js";
import { routeMatches } from "../api/route-contract.js";
import { publicSearchResponse } from "./public-search-response.js";
import { cachedResponse, json, rateLimiterUnavailableResponse } from "./response.js";

/** Options the outer router passes down; see `handleApi`. */
export interface PublicContractRouteOptions {
  /** The rate limiter could not decide: nothing here may reach D1. */
  cacheOnly?: boolean;
}

function cachedSearch(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  cacheOnly: boolean,
): Promise<Response> {
  // Search is served by a cached Worker entrypoint, whose cache this Worker cannot interrogate: it
  // can only be asked to produce a response, which on a miss means a D1 read with no limit in force.
  // So unlike the Cache API reads in the router, search has no cache-only mode and refuses instead.
  if (cacheOnly) return Promise.resolve(rateLimiterUnavailableResponse());
  // The response is public. Client cookies, authorization and cache-busting headers must not
  // fragment/bypass the internal cache. The outer router already checked the rate limit.
  const request = new Request(url);
  if (ctx.exports?.PublicSearchCache) return ctx.exports.PublicSearchCache.fetch(request);
  // Non-Workers callers keep the local Cache API path, without stacking two freshness windows.
  return cachedResponse(request, ctx, () => publicSearchResponse(request, env));
}

interface RuntimeRoute {
  contract: typeof PRODUCT_SEARCH_ROUTE | typeof SUGGEST_ROUTE;
  handle(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    url: URL,
    options: PublicContractRouteOptions,
  ): Promise<Response>;
}

const runtimeRoutes: readonly RuntimeRoute[] = [
  {
    contract: PRODUCT_SEARCH_ROUTE,
    async handle(_request, env, ctx, url, { cacheOnly = false }) {
      const validationError = validateProductQuery(url);
      if (validationError) return json({ error: validationError }, { status: 400 });
      const query = parseProductQuery(url);
      const legacyRule = LEGACY_CATEGORY_MIGRATION_RULES.find(
        (rule) => rule.legacyId === query.category,
      );
      if (legacyRule) {
        console.info(
          JSON.stringify({
            event: "legacy_category_alias_used",
            taxonomyVersion: TAXONOMY_VERSION,
            legacyCategoryId: legacyRule.legacyId,
            canonicalCategoryIds: legacyRule.categoryIds,
          }),
        );
      }
      return cachedSearch(canonicalProductQueryUrl(url, query), env, ctx, cacheOnly);
    },
  },
  {
    contract: SUGGEST_ROUTE,
    async handle(_request, env, ctx, url, { cacheOnly = false }) {
      const validationError = validateSuggestQuery(url);
      if (validationError) return json({ error: validationError }, { status: 400 });
      const query = parseSuggestQuery(url);
      return cachedSearch(canonicalSuggestQueryUrl(url, query), env, ctx, cacheOnly);
    },
  },
];

/**
 * Dispatch routes whose path/method are owned by RouteContract metadata.
 *
 * `null` means no contract-backed route matched and lets the legacy router continue. This keeps the
 * migration incremental while removing duplicated path literals for every migrated endpoint.
 */
export async function handlePublicContractRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: PublicContractRouteOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  for (const route of runtimeRoutes) {
    if (routeMatches(route.contract, request, url)) {
      return route.handle(request, env, ctx, url, options);
    }
  }
  return null;
}
