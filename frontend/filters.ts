/**
 * Filter state and its three serializations: the `/api/products` query, the address bar, and the
 * active-filter chips.
 *
 * {@link ProductFilters} holds the raw trimmed control values rather than parsed numbers. That is
 * deliberate: `minPrice=abc` must still reach the API so the server answers `400 minPrice_invalid`
 * instead of the browser silently dropping it.
 */

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

export type ProductFilters = Record<UrlValueId, string> & Record<ToggleId, boolean>;

export interface FilterEntry {
  id: string;
  label: string;
  /** Counted by the mobile "N filters applied" badge; the free-text query is not. */
  detail: boolean;
}

export interface UrlFilterState {
  values: Record<UrlValueId, string>;
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
