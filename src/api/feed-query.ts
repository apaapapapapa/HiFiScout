import {
  canonicalProductQueryUrl,
  parseProductQuery,
  validateProductQuery,
} from "./product-query.js";
import type { ProductQuery } from "./product-query.js";

/** Feed readers poll repeatedly, so the head of a saved search is intentionally smaller than UI pages. */
export const FEED_MAX_PAGE_SIZE = 25;

function feedInputUrl(url: URL): URL {
  const normalized = new URL(url);
  // A feed is always the current head of a search. Pagination tokens are accepted but ignored so
  // copying a paginated search URL cannot turn the subscription into a permanently stale page.
  normalized.searchParams.delete("cursor");
  normalized.searchParams.delete("offset");
  return normalized;
}

/** Validate the existing product-query vocabulary plus the one feed-specific ordering rule. */
export function validateFeedQuery(url: URL): string | null {
  const normalized = feedInputUrl(url);
  const validationError = validateProductQuery(normalized);
  if (validationError) return validationError;

  const sort = normalized.searchParams.get("sort");
  if (sort && sort !== "newest") return "feed_sort_must_be_newest";
  return null;
}

/**
 * Convert a validated saved-search URL into the ordinary product-search query contract.
 *
 * `explicitSort` is deliberately true even when the URL omitted `sort`: free-text product search
 * otherwise switches to relevance ordering, while an Atom feed must always be chronological.
 */
export function parseFeedQuery(url: URL): ProductQuery {
  const parsed = parseProductQuery(feedInputUrl(url));
  return {
    ...parsed,
    sort: "newest",
    explicitSort: true,
    cursor: null,
    offset: 0,
    limit: Math.min(parsed.limit, FEED_MAX_PAGE_SIZE),
    includeTotal: false,
  };
}

/** One canonical subscription address for all equivalent spellings of the same saved search. */
export function canonicalFeedQueryUrl(url: URL, query: ProductQuery): URL {
  const canonical = canonicalProductQueryUrl(url, {
    ...query,
    // `newest` is intrinsic to /api/feed, not part of the user's saved filter state.
    explicitSort: false,
    cursor: null,
    offset: 0,
    includeTotal: false,
  });
  canonical.pathname = "/api/feed";
  canonical.hash = "";
  return canonical;
}
