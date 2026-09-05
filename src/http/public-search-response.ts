import { parseProductQuery, validateProductQuery } from "../api/product-query.js";
import { parseSuggestQuery, validateSuggestQuery } from "../api/suggest-query.js";
import { PRODUCT_SEARCH_ROUTE, SUGGEST_ROUTE } from "../api/public-route-contracts.js";
import { routeMatches } from "../api/route-contract.js";
import { searchProducts } from "../db/product-search-price-index-repository.js";
import { suggestProducts } from "../db/product-suggest-repository.js";
import { json } from "./response.js";

/** One freshness window: the Workers Cache entrypoint must not wrap another response cache. */
const CACHE_HEADERS = { "cache-control": "public, max-age=30" };

/** Public, request-independent search data only; never dispatch the general/admin router here. */
export async function publicSearchResponse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (routeMatches(PRODUCT_SEARCH_ROUTE, request, url)) {
    const error = validateProductQuery(url);
    if (error) return json({ error }, { status: 400 });
    return json(await searchProducts(env.DB, parseProductQuery(url)), { headers: CACHE_HEADERS });
  }
  if (routeMatches(SUGGEST_ROUTE, request, url)) {
    const error = validateSuggestQuery(url);
    if (error) return json({ error }, { status: 400 });
    return json(
      { suggestions: await suggestProducts(env.DB, parseSuggestQuery(url).q) },
      {
        headers: CACHE_HEADERS,
      },
    );
  }
  return json({ error: "not_found" }, { status: 404 });
}
