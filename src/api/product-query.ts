/**
 * `/api/products` query-string handling.
 *
 * Validation and parsing live at the HTTP boundary so the search repository receives an already
 * normalized value object and never has to know about `URL`/`URLSearchParams`. Both halves are
 * pure functions and are unit-tested without a database.
 */

import { isFeatureId } from "../catalog/product-features.js";
import { PRODUCT_QUERY_SORTS } from "./contracts.js";
import type { ProductQuerySort } from "./contracts.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** Maximum accepted code-point length per string parameter. */
const LENGTH_LIMITS = { q: 100, shop: 80, manufacturer: 100, category: 100, cursor: 1024 };
const MAX_FEATURE_PARAM_LENGTH = 200;
const NUMERIC_PARAMS = ["minPrice", "maxPrice", "limit", "offset"] as const;
const BOOLEAN_PARAMS = ["inStock", "newOnly", "priceDropped", "includeTotal"] as const;

/** Normalized `/api/products` request. Every field is already clamped and defaulted. */
export interface ProductQuery {
  /** Trimmed free-text search; empty when absent. */
  q: string;
  shop: string;
  manufacturer: string;
  category: string;
  /** De-duplicated, validated feature ids. */
  features: string[];
  inStock: boolean;
  newOnly: boolean;
  priceDropped: boolean;
  minPrice: number | null;
  maxPrice: number | null;
  sort: ProductQuerySort;
  /** `?sort=` was supplied. Distinguishes an explicit `newest` from the default. */
  explicitSort: boolean;
  cursor: string | null;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

function trimmed(params: URLSearchParams, key: string): string {
  return params.get(key)?.trim() || "";
}

/** `feature` accepts both repeated parameters and comma-separated values. */
export function requestedFeatures(params: URLSearchParams): string[] {
  return [
    ...new Set(
      params
        .getAll("feature")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function isProductQuerySort(value: string | null): value is ProductQuerySort {
  return value != null && (PRODUCT_QUERY_SORTS as readonly string[]).includes(value);
}

/** Integer parameter, or `null` when absent/unparseable. Never throws on hostile input. */
function integerParam(params: URLSearchParams, key: string): number | null {
  const parsed = Number.parseInt(params.get(key) || "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rejects oversized and malformed query parameters before any SQL is built.
 *
 * Returns an error code for the 400 response, or `null` when the query is acceptable.
 */
export function validateProductQuery(url: URL): string | null {
  const params = url.searchParams;
  for (const [key, maxLength] of Object.entries(LENGTH_LIMITS)) {
    const value = params.get(key);
    if (value != null && [...value].length > maxLength) return `${key}_too_long`;
  }
  for (const value of params.getAll("feature")) {
    if ([...value].length > MAX_FEATURE_PARAM_LENGTH) return "feature_too_long";
  }
  if (requestedFeatures(params).some((feature) => !isFeatureId(feature))) return "feature_invalid";
  for (const key of NUMERIC_PARAMS) {
    const value = params.get(key);
    if (value != null && !/^\d{1,12}$/.test(value)) return `${key}_invalid`;
  }
  for (const key of BOOLEAN_PARAMS) {
    const value = params.get(key);
    if (value != null && value !== "true" && value !== "false") return `${key}_invalid`;
  }
  const sort = params.get("sort");
  if (sort && !isProductQuerySort(sort)) return "sort_invalid";
  return null;
}

/**
 * Normalizes a request URL into a {@link ProductQuery}.
 *
 * Stays defensive rather than assuming {@link validateProductQuery} already ran: unparseable
 * numbers fall back to their defaults instead of reaching SQL.
 */
export function parseProductQuery(url: URL): ProductQuery {
  const params = url.searchParams;
  const requestedLimit = integerParam(params, "limit");
  const requestedOffset = integerParam(params, "offset");
  const sort = params.get("sort");
  return {
    q: trimmed(params, "q"),
    shop: trimmed(params, "shop"),
    manufacturer: trimmed(params, "manufacturer"),
    category: trimmed(params, "category"),
    features: requestedFeatures(params),
    inStock: params.get("inStock") === "true",
    newOnly: params.get("newOnly") === "true",
    priceDropped: params.get("priceDropped") === "true",
    minPrice: integerParam(params, "minPrice"),
    maxPrice: integerParam(params, "maxPrice"),
    sort: isProductQuerySort(sort) ? sort : "newest",
    explicitSort: params.has("sort"),
    cursor: params.get("cursor"),
    limit: Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit ?? DEFAULT_PAGE_SIZE)),
    offset: Math.max(0, requestedOffset ?? 0),
    includeTotal: params.get("includeTotal") === "true",
  };
}

/**
 * Relevance mode replaces keyset pagination with a ranked ORDER BY, so it is only used when the
 * caller supplied a search term and did not pick an explicit sort.
 */
export function usesRelevanceOrder(query: ProductQuery): boolean {
  return Boolean(query.q) && !query.explicitSort;
}
