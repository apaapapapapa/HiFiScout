/**
 * Device-local favorites.
 *
 * Two generations coexist in storage: the current one persists a full product snapshot so a
 * favorite still renders after the listing drops it, while an older build stored bare numeric
 * ids. Both are read; only snapshots are written, and a legacy id is upgraded the next time its
 * product appears in a listing.
 *
 * Matching and sorting are pure so the favorites view can be tested without a browser — it is the
 * one filter path the server does not evaluate.
 */

import {
  activityData,
  activityTime,
  normalizedSearchText,
  priceDropped,
} from "./product-activity.js";
import type { ProductFilters } from "./filters.js";
import type { DisplayProduct } from "./types.js";

export const FAVORITES_KEY = "hifiscout:favorites";

export interface FavoriteStore {
  products: Map<number, DisplayProduct>;
  legacyIds: Set<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Typed boundary: favorites come back from localStorage as `unknown`. Only the id is validated —
 * the remaining fields were written by `favoriteSnapshot()` and are rendered through
 * `escapeHtml`, so a tampered entry can produce a wrong-looking card but not markup.
 */
function isFavoriteEntry(value: unknown): value is DisplayProduct {
  return isRecord(value) && Number.isSafeInteger(Number(value.id));
}

/** Never throws: malformed local data yields an empty collection rather than a broken page. */
export function parseFavoriteStorage(raw: string | null): FavoriteStore {
  const products = new Map<number, DisplayProduct>();
  const legacyIds = new Set<number>();
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return { products, legacyIds };
    const entries: unknown[] = parsed;
    for (const entry of entries) {
      if (isFavoriteEntry(entry)) {
        products.set(Number(entry.id), { ...entry, id: Number(entry.id) });
        continue;
      }
      const id = Number(entry);
      if (Number.isSafeInteger(id) && id > 0) legacyIds.add(id);
    }
  } catch {
    // Ignore malformed local data and start with an empty favorite collection.
  }
  return { products, legacyIds };
}

/** Explicit field list: a snapshot must not grow just because the API item did. */
export function favoriteSnapshot(product: DisplayProduct): DisplayProduct {
  return {
    id: product.id ?? null,
    shop_key: product.shop_key ?? null,
    manufacturer: product.manufacturer ?? null,
    manufacturer_id: product.manufacturer_id ?? null,
    raw_manufacturer: product.raw_manufacturer ?? null,
    model: product.model ?? null,
    title: product.title ?? null,
    category: product.category ?? null,
    raw_category: product.raw_category ?? null,
    primary_category_id: product.primary_category_id ?? null,
    condition_text: product.condition_text ?? null,
    price_yen: product.price_yen ?? null,
    previous_price_yen: product.previous_price_yen ?? null,
    stock_status: product.stock_status ?? null,
    source_url: product.source_url ?? null,
    first_seen_at: product.first_seen_at ?? null,
    last_seen_at: product.last_seen_at ?? null,
    last_changed_at: product.last_changed_at ?? null,
    last_activity_at: product.last_activity_at ?? null,
    search_aliases: product.search_aliases ?? null,
    category_ids: Array.isArray(product.category_ids) ? [...product.category_ids] : [],
  };
}

/** What to persist: legacy ids first, then snapshots, matching the read order. */
export function favoriteStoragePayload(store: FavoriteStore): unknown[] {
  return [...store.legacyIds, ...store.products.values()];
}

/**
 * Client-side equivalent of the server's `/api/products` filtering, applied to snapshots.
 *
 * `categoryLabel` is the selected `<option>` text, which lets a snapshot taken before the
 * category taxonomy existed still match by its free-text category.
 */
export function favoriteMatchesFilters(
  product: DisplayProduct,
  filters: ProductFilters,
  categoryLabel: string,
  now = Date.now(),
): boolean {
  const q = filters.q.trim().toLocaleLowerCase("ja-JP");
  if (q && !normalizedSearchText(product).includes(q)) return false;
  if (filters.shop && product.shop_key !== filters.shop) return false;
  if (filters.manufacturer && product.manufacturer !== filters.manufacturer) return false;
  if (filters.category) {
    const ids = Array.isArray(product.category_ids) ? product.category_ids : [];
    if (
      !ids.includes(filters.category) &&
      product.primary_category_id !== filters.category &&
      product.category !== categoryLabel
    ) {
      return false;
    }
  }
  if (filters.inStock && product.stock_status !== "in_stock") return false;
  if (filters.recentOnly && !activityData(product, now).isNew) return false;
  if (filters.priceDropped && !priceDropped(product)) return false;
  const minPrice = Number.parseInt(filters.minPrice, 10);
  // A null price coerces to 0 in the original relational comparison; `?? 0` keeps that.
  if (Number.isFinite(minPrice) && !((product.price_yen ?? 0) >= minPrice)) return false;
  const maxPrice = Number.parseInt(filters.maxPrice, 10);
  if (Number.isFinite(maxPrice) && !((product.price_yen ?? 0) <= maxPrice)) return false;
  return true;
}

/** Price sorts push unpriced listings last in both directions; everything else is by recency. */
export function sortFavorites(products: DisplayProduct[], sort: string): DisplayProduct[] {
  const sorted = [...products];
  sorted.sort((left, right) => {
    if (sort === "priceAsc" || sort === "priceDesc") {
      if (left.price_yen == null && right.price_yen == null) return 0;
      if (left.price_yen == null) return 1;
      if (right.price_yen == null) return -1;
      return sort === "priceAsc"
        ? left.price_yen - right.price_yen
        : right.price_yen - left.price_yen;
    }
    return activityTime(right) - activityTime(left);
  });
  return sorted;
}

/** The favorites view: filter, then sort. */
export function favoriteResults(
  store: FavoriteStore,
  filters: ProductFilters,
  categoryLabel: string,
  now = Date.now(),
): DisplayProduct[] {
  const matching = [...store.products.values()].filter((product) =>
    favoriteMatchesFilters(product, filters, categoryLabel, now),
  );
  return sortFavorites(matching, filters.sort);
}
