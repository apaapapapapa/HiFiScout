/**
 * Filter state and its three serializations: the `/api/product-search` query, the address bar, and
 * the active-filter chips.
 *
 * {@link ProductFilters} holds the raw trimmed control values rather than parsed numbers. That is
 * deliberate: `minPrice=abc` must still reach the API so the server answers `400 minPrice_invalid`
 * instead of the browser silently dropping it.
 *
 * The query vocabulary is unchanged by Phase 4, so a shared URL still works — but the server now
 * splits it into product-level and offer-level predicates, and `limit`/`offset` count products.
 */

import { FACET_DEFINITIONS, FEATURE_DEFINITIONS } from "../src/api/contracts.js";
import type { FacetSelection, FeatureId } from "../src/api/contracts.js";
import { yen } from "./format.js";
import { PAGE_SIZE, pageOffset } from "./pagination.js";

export const DEFAULT_SORT = "newest";

/** Text/select controls that round-trip through both the API query and the URL, in that order. */
export const URL_VALUE_IDS = [
  "q",
  "shop",
  "manufacturer",
  "category",
  "minPrice",
  "maxPrice",
  "sort",
] as const;

export type UrlValueId = (typeof URL_VALUE_IDS)[number];

/** Checkbox controls. `inStock` defaults to on, which is why the URL encodes its *off* state. */
export const TOGGLE_IDS = ["inStock", "favoritesOnly", "recentOnly", "priceDropped"] as const;

export type ToggleId = (typeof TOGGLE_IDS)[number];

export type ProductView = "cards" | "list";

/** Keyed by plain string so untrusted input can be tested for membership without a cast. */
const FEATURE_NAMES = new Map<string, string>(
  FEATURE_DEFINITIONS.map((feature) => [feature.id, feature.name]),
);
const FACET_NAMES = new Map<string, string>(
  FACET_DEFINITIONS.flatMap((facet) =>
    facet.values.map(
      (value) => [`${facet.id}:${value.id}`, `${facet.name}: ${value.name}`] as const,
    ),
  ),
);

/** Chip id for one selected feature, so a single chip can clear a single feature. */
export function featureFilterId(feature: FeatureId): string {
  return `feature:${feature}`;
}

/** The feature a chip id names, or null when the id belongs to another control. */
export function featureFromFilterId(id: string): FeatureId | null {
  const feature = id.startsWith("feature:") ? id.slice("feature:".length) : "";
  return FEATURE_NAMES.has(feature) ? (feature as FeatureId) : null;
}

export function facetSelectionKey(selection: FacetSelection): string {
  return `${selection.facetId}:${selection.value}`;
}

export function facetFilterId(selection: FacetSelection): string {
  return `facet:${facetSelectionKey(selection)}`;
}

export function facetFromFilterId(id: string): FacetSelection | null {
  const key = id.startsWith("facet:") ? id.slice("facet:".length) : "";
  const separator = key.indexOf(":");
  if (separator <= 0 || !FACET_NAMES.has(key)) return null;
  return {
    facetId: key.slice(0, separator) as FacetSelection["facetId"],
    value: key.slice(separator + 1),
  };
}

/**
 * Features are a third axis rather than a member of either map above.
 *
 * `?feature=` is repeatable, and neither the string map nor the boolean map can hold more than one
 * value per key. Sorting on the way out is what lets two selections made in a different order
 * collapse onto the same edge-cache key the server canonicalises to.
 */
export type ProductFilters = Record<UrlValueId, string> &
  Record<ToggleId, boolean> & {
    features: readonly FeatureId[];
    facets: readonly FacetSelection[];
  };

function featureParams(features: readonly FeatureId[]): FeatureId[] {
  return [...new Set(features)].sort();
}

function facetParams(facets: readonly FacetSelection[]): FacetSelection[] {
  return [...new Map(facets.map((facet) => [facetSelectionKey(facet), facet])).values()].sort(
    (left, right) => facetSelectionKey(left).localeCompare(facetSelectionKey(right)),
  );
}

/** Reads the repeated/comma-separated `feature` form, dropping anything outside the vocabulary. */
export function parseFeatureParams(params: URLSearchParams): FeatureId[] {
  const requested = params
    .getAll("feature")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is FeatureId => FEATURE_NAMES.has(value));
  return featureParams(requested);
}

export function parseFacetParams(params: URLSearchParams): FacetSelection[] {
  const selections: FacetSelection[] = [];
  for (const raw of params.getAll("facet").flatMap((value) => value.split(","))) {
    const key = raw.trim();
    const separator = key.indexOf(":");
    if (separator <= 0 || !FACET_NAMES.has(key)) continue;
    selections.push({
      facetId: key.slice(0, separator) as FacetSelection["facetId"],
      value: key.slice(separator + 1),
    });
  }
  return facetParams(selections);
}

export interface FilterEntry {
  id: string;
  label: string;
  /** Counted by the mobile "N filters applied" badge; the free-text query is not. */
  detail: boolean;
}

export interface UrlFilterState {
  values: Record<UrlValueId, string>;
  features: FeatureId[];
  facets: FacetSelection[];
  inStock: boolean;
  recentOnly: boolean;
  priceDropped: boolean;
  /** Absent when the URL carries no valid `view`, so the stored preference wins. */
  view: ProductView | null;
}

export interface ProductParamsOptions {
  cursor?: string | null;
  page?: number;
  includeTotal?: boolean;
}

function intOrNull(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The `/api/products` query for a page of results. */
export function productSearchParams(
  filters: ProductFilters,
  { cursor = null, page = 1, includeTotal = false }: ProductParamsOptions = {},
): URLSearchParams {
  const params = new URLSearchParams();
  for (const id of URL_VALUE_IDS) {
    const value = filters[id].trim();
    if (value) params.set(id, value);
  }
  for (const feature of featureParams(filters.features)) params.append("feature", feature);
  for (const facet of facetParams(filters.facets)) params.append("facet", facetSelectionKey(facet));
  if (filters.inStock) params.set("inStock", "true");
  if (filters.recentOnly) params.set("newOnly", "true");
  if (filters.priceDropped) params.set("priceDropped", "true");
  params.set("limit", String(PAGE_SIZE));
  // A cursor resumes exactly where the previous page ended; `offset` is the fallback for a jump.
  if (cursor) params.set("cursor", cursor);
  else if (page > 1) params.set("offset", String(pageOffset(page)));
  if (includeTotal) params.set("includeTotal", "true");
  return params;
}

/** The account-free subscription address for the current server-side filter state. */
export function savedSearchFeedPath(filters: ProductFilters): string {
  const params = productSearchParams(filters);
  // Feed order and page size are server-owned; neither is part of the saved-search filter contract.
  params.delete("sort");
  params.delete("limit");
  params.delete("cursor");
  params.delete("offset");
  params.delete("includeTotal");
  const search = params.toString();
  return `/api/feed${search ? `?${search}` : ""}`;
}

/**
 * The address-bar query.
 *
 * Only non-default state is encoded so a plain visit keeps a clean URL — except `inStock`, whose
 * default is on, so turning it off is what needs recording.
 */
export function filterUrlParams(filters: ProductFilters, view: ProductView): URLSearchParams {
  const params = new URLSearchParams();
  for (const id of URL_VALUE_IDS) {
    const value = filters[id].trim();
    if (!value) continue;
    if (id === "sort" && value === DEFAULT_SORT) continue;
    params.set(id, value);
  }
  for (const feature of featureParams(filters.features)) params.append("feature", feature);
  for (const facet of facetParams(filters.facets)) params.append("facet", facetSelectionKey(facet));
  if (!filters.inStock) params.set("inStock", "false");
  if (filters.recentOnly) params.set("newOnly", "true");
  if (filters.priceDropped) params.set("priceDropped", "true");
  if (view === "cards") params.set("view", "cards");
  return params;
}

/** Reads a shareable URL back into control values. `favoritesOnly` is never encoded. */
export function parseUrlFilters(search: string): UrlFilterState {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  return {
    values: {
      q: params.get("q") || "",
      shop: params.get("shop") || "",
      manufacturer: params.get("manufacturer") || "",
      category: params.get("category") || "",
      minPrice: params.get("minPrice") || "",
      maxPrice: params.get("maxPrice") || "",
      sort: params.get("sort") || DEFAULT_SORT,
    },
    features: parseFeatureParams(params),
    facets: parseFacetParams(params),
    inStock: params.get("inStock") !== "false",
    recentOnly: params.get("newOnly") === "true",
    priceDropped: params.get("priceDropped") === "true",
    view: view === "cards" || view === "list" ? view : null,
  };
}

export interface FilterLabels {
  /** Display name of the selected shop; falls back to the key when unknown. */
  shop: string;
  /** Display name of the selected category option. */
  category: string;
}

/** Chips shown above the results, in the order they are rendered. */
export function activeFilterEntries(filters: ProductFilters, labels: FilterLabels): FilterEntry[] {
  const entries: FilterEntry[] = [];
  const minPrice = intOrNull(filters.minPrice);
  const maxPrice = intOrNull(filters.maxPrice);
  if (filters.q) entries.push({ id: "q", label: `検索: ${filters.q}`, detail: false });
  if (filters.shop) entries.push({ id: "shop", label: labels.shop, detail: true });
  if (filters.manufacturer) {
    entries.push({ id: "manufacturer", label: filters.manufacturer, detail: true });
  }
  if (filters.category) {
    entries.push({ id: "category", label: labels.category || filters.category, detail: true });
  }
  if (minPrice != null) {
    entries.push({ id: "minPrice", label: `${yen.format(minPrice)}以上`, detail: true });
  }
  if (maxPrice != null) {
    entries.push({ id: "maxPrice", label: `${yen.format(maxPrice)}以下`, detail: true });
  }
  // Favorites are matched locally against stored snapshots, which carry no feature facts, so the
  // predicate cannot be applied there. The selection is kept — it applies again the moment the mode
  // is turned off — but claiming it as an active filter while results ignore it would be a lie.
  if (!filters.favoritesOnly) {
    for (const feature of featureParams(filters.features)) {
      entries.push({
        id: featureFilterId(feature),
        label: FEATURE_NAMES.get(feature) || feature,
        detail: true,
      });
    }
    for (const facet of facetParams(filters.facets)) {
      const key = facetSelectionKey(facet);
      entries.push({
        id: facetFilterId(facet),
        label: FACET_NAMES.get(key) || key,
        detail: true,
      });
    }
  }
  if (filters.inStock) entries.push({ id: "inStock", label: "在庫あり", detail: true });
  if (filters.recentOnly) {
    entries.push({ id: "recentOnly", label: "48時間以内の新着", detail: true });
  }
  if (filters.priceDropped) entries.push({ id: "priceDropped", label: "値下げ商品", detail: true });
  if (filters.favoritesOnly) {
    entries.push({ id: "favoritesOnly", label: "お気に入り", detail: true });
  }
  return entries;
}
