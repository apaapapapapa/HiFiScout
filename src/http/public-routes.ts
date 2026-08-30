import {
  canonicalSuggestQueryUrl,
  parseSuggestQuery,
  validateSuggestQuery,
} from "../api/suggest-query.js";
import { parseProductQuery, validateProductQuery } from "../api/product-query.js";
import { LEGACY_CATEGORY_MIGRATION_RULES, TAXONOMY_VERSION } from "../catalog/categories.js";
import { PRODUCT_SEARCH_ROUTE, SUGGEST_ROUTE } from "../api/public-route-contracts.js";
import { routeMatches } from "../api/route-contract.js";
import { searchProducts } from "../db/product-search-price-index-repository.js";
import { suggestProducts } from "../db/product-suggest-repository.js";
import { cachedJson, json } from "./response.js";

/** Seconds the edge may serve a cached contract-backed read response. */
const READ_CACHE_TTL_SECONDS = 30;

interface RuntimeRoute {
  contract: typeof PRODUCT_SEARCH_ROUTE | typeof SUGGEST_ROUTE;
  handle(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response>;
}

const runtimeRoutes: readonly RuntimeRoute[] = [
  {
    contract: PRODUCT_SEARCH_ROUTE,
    async handle(request, env, ctx, url) {
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
      return cachedJson(request, ctx, READ_CACHE_TTL_SECONDS, () => searchProducts(env.DB, query));
    },
  },
  {
    contract: SUGGEST_ROUTE,
    async handle(request, env, ctx, url) {
      const validationError = validateSuggestQuery(url);
      if (validationError) return json({ error: validationError }, { status: 400 });
      const query = parseSuggestQuery(url);
      const cacheRequest = new Request(canonicalSuggestQueryUrl(url, query).toString(), request);
      return cachedJson(cacheRequest, ctx, READ_CACHE_TTL_SECONDS, async () => ({
        suggestions: await suggestProducts(env.DB, query.q),
      }));
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
): Promise<Response | null> {
  const url = new URL(request.url);
  for (const route of runtimeRoutes) {
    if (routeMatches(route.contract, request, url)) {
      return route.handle(request, env, ctx, url);
    }
  }
  return null;
}
