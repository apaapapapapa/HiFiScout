import type { ProductFilters } from "./filters.js";
import { filterUrlParams, parseUrlFilters } from "./filters.js";
import { sanitizedCatalogSearch } from "./catalog-url-sanitizer.js";

export const SAVED_SEARCHES_KEY = "hifiscout:saved-searches:v1";
export const MAX_SAVED_SEARCHES = 20;
export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  updatedAt: string;
}

/** Store the bounded public query vocabulary, never URLs, favorite mode or pagination. */
export function canonicalSavedSearchQuery(search: string): string {
  const params = new URLSearchParams(sanitizedCatalogSearch(search));
  params.delete("compare");
  params.delete("view");
  return params.toString();
}

export function savedSearchFilters(query: string): ProductFilters {
  const parsed = parseUrlFilters(canonicalSavedSearchQuery(query));
  return { ...parsed.values, features: parsed.features, facets: parsed.facets,
    offerFacts: parsed.offerFacts, inStock: parsed.inStock, recentOnly: parsed.recentOnly,
    priceDropped: parsed.priceDropped, favoritesOnly: false };
}

export function savedSearchQuery(filters: ProductFilters): string | null {
  const query = filterUrlParams(filters, "list").toString();
  if (canonicalSavedSearchQuery(query) !== query || query.length > 8000) return null;
  if (filters.minPrice && filters.maxPrice && Number(filters.minPrice) > Number(filters.maxPrice)) return null;
  return query;
}

export function savedSearchName(value: string): string | null {
  const name = value.trim();
  return name && [...name].length <= 80 ? name : null;
}

/** Malformed entries cannot break boot or widen a saved search without an explicit save. */
export function parseSavedSearches(raw: string | null): SavedSearch[] {
  if (!raw || raw.length > 200_000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_SAVED_SEARCHES) return [];
    const ids = new Set<string>();
    return value.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(row.id) || ids.has(row.id) ||
          typeof row.name !== "string" || !savedSearchName(row.name) || typeof row.query !== "string" || row.query.length > 8000 ||
          canonicalSavedSearchQuery(row.query) !== row.query || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) return [];
      const filters = savedSearchFilters(row.query);
      if (filters.minPrice && filters.maxPrice && Number(filters.minPrice) > Number(filters.maxPrice)) return [];
      ids.add(row.id);
      return [{ id: row.id, name: row.name.trim(), query: row.query, updatedAt: row.updatedAt }];
    });
  } catch { return []; }
}
