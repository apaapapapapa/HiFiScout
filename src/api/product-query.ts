/**
 * `/api/product-search` query-string handling.
 *
 * Validation and parsing live at the HTTP boundary so the search repository receives an already
 * normalized value object and never has to know about `URL`/`URLSearchParams`. Both halves are
 * pure functions and are unit-tested without a database.
 */

import { FEATURE_DEFINITIONS } from "../catalog/types.js";
import { facetSelectionKey, parseFacetSelection } from "../catalog/product-facets.js";
import { PRODUCT_QUERY_SORTS } from "./contracts.js";
import { validateQueryContract } from "./route-contract.js";
import type { ProductQuerySort } from "./contracts.js";
import type { FacetSelection } from "../catalog/types.js";
import type { QueryParameterContract } from "./route-contract.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
/** Offset pagination is retained for direct page navigation, but bounded to prevent deep scans. */
export const MAX_OFFSET = 10_000;

/** Maximum accepted code-point length per string parameter. */
const LENGTH_LIMITS = { q: 100, shop: 80, manufacturer: 100, category: 100, cursor: 1024 };
const MAX_FEATURE_PARAM_LENGTH = 200;
const MAX_FACET_PARAM_LENGTH = 200;
const FEATURE_IDS = FEATURE_DEFINITIONS.map((feature) => feature.id);

/**
 * Machine-readable query contract shared by runtime validation and OpenAPI generation.
 *
 * `limit` deliberately has no OpenAPI maximum: larger non-negative values are accepted and then
 * clamped to `MAX_PAGE_SIZE`, preserving the existing HTTP behavior.
 */
export const PRODUCT_QUERY_PARAMETERS = [
  {
    name: "q",
    type: "string",
    maxLength: LENGTH_LIMITS.q,
    description: "Free-text product search. Leading and trailing whitespace is ignored.",
  },
  {
    name: "shop",
    type: "string",
    maxLength: LENGTH_LIMITS.shop,
    description: "Restrict matches to offers from one shop key.",
  },
  {
    name: "manufacturer",
    type: "string",
    maxLength: LENGTH_LIMITS.manufacturer,
    description: "Restrict matches to one manufacturer display name.",
  },
  {
    name: "category",
    type: "string",
    maxLength: LENGTH_LIMITS.category,
    description: "Restrict matches to a canonical category id.",
  },
  {
    name: "cursor",
    type: "string",
    maxLength: LENGTH_LIMITS.cursor,
    description: "Opaque keyset-pagination cursor returned by the previous response.",
  },
  {
    name: "feature",
    type: "string",
    repeatable: true,
    commaSeparated: true,
    maxLength: MAX_FEATURE_PARAM_LENGTH,
    enum: FEATURE_IDS,
    description: "Required product feature. May be repeated or supplied as a comma-separated list.",
  },
  {
    name: "facet",
    type: "string",
    repeatable: true,
    commaSeparated: true,
    maxLength: MAX_FACET_PARAM_LENGTH,
    description: "Required typed facet as facet_id:value. May be repeated or comma-separated.",
  },
  {
    name: "minPrice",
    type: "integer",
    minimum: 0,
    maxDigits: 12,
    description: "Minimum offer price in JPY.",
  },
  {
    name: "maxPrice",
    type: "integer",
    minimum: 0,
    maxDigits: 12,
    description: "Maximum offer price in JPY.",
  },
  {
    name: "limit",
    type: "integer",
    minimum: 0,
    maxDigits: 12,
    description: `Requested page size; normalized into the range 1-${MAX_PAGE_SIZE}.`,
  },
  {
    name: "offset",
    type: "integer",
    minimum: 0,
    maximum: MAX_OFFSET,
    maximumError: "offset_too_large",
    maxDigits: 12,
    description: `Offset pagination, bounded to ${MAX_OFFSET}.`,
  },
  {
    name: "inStock",
    type: "boolean",
    description: "Return only products with a matching in-stock offer.",
  },
  {
    name: "newOnly",
    type: "boolean",
    description: "Return only products with a newly observed matching offer.",
  },
  {
    name: "priceDropped",
    type: "boolean",
    description: "Return only products with a matching price drop.",
  },
  {
    name: "includeTotal",
    type: "boolean",
    description: "Include totalCount and totalPages in the response.",
  },
  {
    name: "sort",
    type: "string",
    enum: PRODUCT_QUERY_SORTS,
    description:
      "Explicit result ordering. Omitting it enables relevance ordering for text search.",
  },
] as const satisfies readonly QueryParameterContract[];

/** Normalized `/api/product-search` request. Every field is already clamped and defaulted. */
export interface ProductQuery {
  /** Trimmed free-text search; empty when absent. */
  q: string;
  shop: string;
  manufacturer: string;
  category: string;
  /** De-duplicated, validated feature ids. */
  features: string[];
  /** OR within one facet id, AND across distinct facet ids. */
  facets: FacetSelection[];
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

export function requestedFacetSelections(params: URLSearchParams): FacetSelection[] {
  const byKey = new Map<string, FacetSelection>();
  for (const value of params.getAll("facet").flatMap((entry) => entry.split(","))) {
    const selection = parseFacetSelection(value.trim());
    if (selection) byKey.set(facetSelectionKey(selection), selection);
  }
  return [...byKey.values()];
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
 * The constraints are declared once in `PRODUCT_QUERY_PARAMETERS`; that same metadata is rendered
 * into the OpenAPI description, so changing an accepted value cannot silently leave docs stale.
 */
export function validateProductQuery(url: URL): string | null {
  const contractError = validateQueryContract(url, PRODUCT_QUERY_PARAMETERS);
  if (contractError) return contractError;
  const requested = url.searchParams
    .getAll("facet")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return requested.some((value) => !parseFacetSelection(value)) ? "invalid_facet" : null;
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
    facets: requestedFacetSelections(params),
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
  for (const facet of [...query.facets].sort((left, right) =>
    facetSelectionKey(left).localeCompare(facetSelectionKey(right)),
  )) params.append("facet", facetSelectionKey(facet));
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
