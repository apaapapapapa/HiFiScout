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
/** Offset pagination is retained for direct page navigation, but bounded to prevent deep scans. */
export const MAX_OFFSET = 10_000;

/** Maximum accepted code-point length per string parameter. */
const LENGTH_LIMITS = { q: 100, shop: 80, manufacturer: 100, category: 100, cursor: 1024 };
const MAX_FEATURE_PARAM_LENGTH = 200;
const NUMERIC_PARAMS = ["minPrice", "maxPrice", "limit", "offset"] as const;
const BOOLEAN_PARAMS = ["inStock", "newOnly", "priceDropped", "includeTotal"] as const;
const SINGLE_VALUE_PARAMS = [
  "q",
  "shop",
  "manufacturer",
  "category",
  "inStock",
  "newOnly",
  "priceDropped",
  "minPrice",
  "maxPrice",
  "sort",
  "cursor",
  "limit",
  "offset",
  "includeTotal",
] as const;
const ALLOWED_PARAMS = new Set<string>([...SINGLE_VALUE_PARAMS, "feature"]);

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
 * Unknown keys are rejected instead of ignored: otherwise an attacker can append arbitrary cache
 * busters to semantically identical searches and force D1 to execute every request.
 *
 * Returns an error code for the 400 response, or `null` when the query is acceptable.
 */
export function validateProductQuery(url: URL): string | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) return "parameter_unknown";
  }
  for (const key of SINGLE_VALUE_PARAMS) {
    if (params.getAll(key).length > 1) return `${key}_repeated`;
  }
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
  const offset = integerParam(params, "offset");
  if (offset != null && offset > MAX_OFFSET) return "offset_too_large";
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
    offset: Math.min(MAX_OFFSET, Math.max(0, requestedOffset ?? 0)),
    includeTotal: params.get("includeTotal") === "true",
  };
}

/**
 * Canonical cache URL for a validated query.
 *
 * Equivalent requests collapse to one edge-cache key regardless of parameter order, whitespace,
 * leading zeroes or repeated feature ordering. `explicitSort` is preserved because an explicit
 * `newest` intentionally disables relevance ordering for a free-text query.
 */
export function canonicalProductQueryUrl(url: URL, query: ProductQuery): URL {
  const canonical = new URL(url);
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.shop) params.set("shop", query.shop);
  if (query.manufacturer) params.set("manufacturer", query.manufacturer);
  if (query.category) params.set("category", query.category);
  for (const feature of [...query.features].sort()) params.append("feature", feature);
  if (query.inStock) params.set("inStock", "true");
  if (query.newOnly) params.set("newOnly", "true");
  if (query.priceDropped) params.set("priceDropped", "true");
  if (query.minPrice != null) params.set("minPrice", String(query.minPrice));
  if (query.maxPrice != null) params.set("maxPrice", String(query.maxPrice));
  if (query.explicitSort) params.set("sort", query.sort);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit));
  if (query.offset > 0) params.set("offset", String(query.offset));
  if (query.includeTotal) params.set("includeTotal", "true");
  canonical.search = params.toString();
  return canonical;
}

/**
 * Relevance mode replaces keyset pagination with a ranked ORDER BY, so it is only used when the
 * caller supplied a search term and did not pick an explicit sort.
 */
export function usesRelevanceOrder(query: ProductQuery): boolean {
  return Boolean(query.q) && !query.explicitSort;
}
