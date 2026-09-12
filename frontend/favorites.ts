/**
 * Device-local favorites.
 *
 * A favorite is a product, keyed by the search entity key the server issued. What is stored is a
 * full snapshot, so a favorite still renders after every shop stops listing it.
 *
 * Three generations coexist in storage, and the two older ones are seller-listing shaped:
 *
 * 1. bare numeric listing ids, written by the oldest build;
 * 2. listing snapshots (`{id, shop_key, model, price_yen, ...}`);
 * 3. product snapshots, written by this build.
 *
 * Listing ids are never reinterpreted as product ids. A generation-2 snapshot is migrated into a
 * product-shaped favorite whose key is `legacy-<listing id>` — a namespace no server key can
 * occupy — and whose single offer carries the original listing id, so the entry stays renderable
 * and its shop link stays correct without pretending the identity layer confirmed anything.
 * Generation-1 entries carry no snapshot at all: they are counted and surfaced as a notice, since
 * a listing id can no longer be resolved by a search that returns products.
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
import { productPriceIndex } from "./price-index-ui.js";
import { safeDate } from "./format.js";
import type { ProductFilters } from "./filters.js";
import type { DisplayOffer, DisplayProduct } from "./types.js";
import { parseFtsSearchQuery } from "../src/search/fts-query.js";
import { parseWatchObservations } from "./watch-changes.js";
import type { WatchObservation } from "./watch-changes.js";

export const FAVORITES_KEY = "hifiscout:favorites";

/** Namespace for migrated seller-listing favorites; never collides with a server entity key. */
export const LEGACY_FAVORITE_PREFIX = "legacy-";

export function isLegacyFavoriteKey(key: string): boolean {
  return key.startsWith(LEGACY_FAVORITE_PREFIX);
}

export interface FavoriteStore {
  products: Map<string, FavoriteProduct>;
  /** Listing ids from the oldest storage format, which carry nothing renderable. */
  legacyIds: Set<number>;
}

/** Optional local evidence from the existing bounded detail refresh; never sent to the server. */
export type FavoriteProduct = DisplayProduct & { favorite_offers?: WatchObservation };

function favoriteObservation(product: FavoriteProduct): WatchObservation | undefined {
  if (!product.favorite_offers) return undefined;
  return parseWatchObservations(JSON.stringify([product.favorite_offers])).find(
    (entry) => entry.key === product.key,
  );
}

export function favoriteShopMatch(
  product: FavoriteProduct,
  shops: readonly string[],
  filters: Pick<ProductFilters, "inStock" | "minPrice" | "maxPrice"> = {
    inStock: false,
    minPrice: "",
    maxPrice: "",
  },
): "match" | "missing" | "unknown" {
  if (!shops.length) return "match";
  const observation = product.favorite_offers;
  const matches = (shop: string, price: number | null, stock: string) =>
    shops.includes(shop) &&
    (!filters.inStock || stock === "in_stock") &&
    (!filters.minPrice || (price !== null && price >= Number(filters.minPrice))) &&
    (!filters.maxPrice || (price !== null && price <= Number(filters.maxPrice)));
  if (observation?.offers.some((offer) => matches(offer.shopKey, offer.priceYen, offer.stock)))
    return "match";
  if (observation?.complete) return "missing";
  const offer = product.representative_offer;
  if (offer && matches(offer.shop_key, offer.price_yen, offer.stock_status)) return "match";
  return product.offer_count <= 1 && product.representative_offer ? "missing" : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function stockStatus(value: unknown): DisplayOffer["stock_status"] {
  return value === "in_stock" || value === "sold_out" ? value : "unknown";
}

/** Explicit field list: a snapshot must not grow just because the API item did. */
export function favoriteSnapshot(product: FavoriteProduct): FavoriteProduct {
  const categoryIds = stringArray(product.category_ids);
  const directCategoryIds = stringArray(product.direct_category_ids);
  const directCategories = stringArray(product.direct_categories);
  const priceIndex = productPriceIndex(product);
  const observation = favoriteObservation(product);
  return {
    ...(observation ? { favorite_offers: observation } : {}),
    key: product.key,
    identity_kind: product.identity_kind,
    catalog_product_id: product.catalog_product_id,
    manufacturer: product.manufacturer,
    manufacturer_id: product.manufacturer_id,
    model: product.model,
    primary_category_id: product.primary_category_id,
    ...(categoryIds ? { category_ids: [...categoryIds] } : {}),
    ...(directCategoryIds ? { direct_category_ids: [...directCategoryIds] } : {}),
    // The labels travel with the ids: a favorite is rendered from the snapshot alone, and the
    // browser cannot turn a category id into a label.
    ...(directCategories ? { direct_categories: [...directCategories] } : {}),
    category: product.category,
    offer_count: product.offer_count,
    in_stock_offer_count: product.in_stock_offer_count,
    sold_out_offer_count: product.sold_out_offer_count,
    shop_count: product.shop_count,
    lowest_price_yen: product.lowest_price_yen,
    highest_price_yen: product.highest_price_yen,
    latest_activity_at: product.latest_activity_at,
    newest_listed_at: product.newest_listed_at,
    has_new_offer: product.has_new_offer,
    has_price_drop: product.has_price_drop,
    ...(priceIndex
      ? {
          price_index: {
            ...priceIndex,
            listing_end_observations: [...priceIndex.listing_end_observations],
          },
        }
      : {}),
    representative_offer: product.representative_offer ? { ...product.representative_offer } : null,
  };
}

/**
 * Turns a stored seller-listing snapshot into a product-shaped favorite.
 *
 * Explicit rather than incidental: the listing id lands on the offer, the entity key is namespaced,
 * and the identity kind is `unresolved_listing` because nothing about this entry was confirmed by
 * the catalog. Counts are 1 because a listing snapshot only ever described one shop's offer.
 */
export function migrateListingFavorite(entry: Record<string, unknown>): DisplayProduct | null {
  const listingId = Number(entry.id);
  if (!Number.isSafeInteger(listingId) || listingId <= 0) return null;
  const price = nullableNumber(entry.price_yen);
  const listedAt = text(entry.first_seen_at) || null;
  const activityAt = text(entry.last_activity_at) || listedAt;
  const status = stockStatus(entry.stock_status);
  const previousPrice = nullableNumber(entry.previous_price_yen);
  const categoryIds = stringArray(entry.category_ids);
  const directCategoryIds = stringArray(entry.direct_category_ids);
  const directCategories = stringArray(entry.direct_categories);
  return {
    key: `${LEGACY_FAVORITE_PREFIX}${listingId}`,
    identity_kind: "unresolved_listing",
    catalog_product_id: null,
    manufacturer: text(entry.manufacturer),
    manufacturer_id: text(entry.manufacturer_id),
    model: text(entry.model) || text(entry.title),
    primary_category_id: text(entry.primary_category_id),
    ...(categoryIds ? { category_ids: [...categoryIds] } : {}),
    ...(directCategoryIds ? { direct_category_ids: [...directCategoryIds] } : {}),
    ...(directCategories ? { direct_categories: [...directCategories] } : {}),
    category: text(entry.category),
    offer_count: 1,
    in_stock_offer_count: status === "in_stock" ? 1 : 0,
    sold_out_offer_count: status === "sold_out" ? 1 : 0,
    shop_count: 1,
    lowest_price_yen: price,
    highest_price_yen: price,
    latest_activity_at: activityAt,
    newest_listed_at: listedAt,
    has_new_offer: false,
    has_price_drop: previousPrice != null && price != null && price < previousPrice,
    representative_offer: {
      listing_product_id: listingId,
      shop_key: text(entry.shop_key),
      source_url: text(entry.source_url),
      title: text(entry.title),
      condition_text: text(entry.condition_text),
      presentation_color: text(entry.presentation_color),
      price_yen: price,
      previous_price_yen: previousPrice,
      stock_status: status,
      first_seen_at: text(entry.first_seen_at),
      last_seen_at: text(entry.last_seen_at),
      last_activity_at: activityAt,
      source_published_at: null,
    },
  };
}

/** Never throws: malformed local data yields an empty collection rather than a broken page. */
export function parseFavoriteStorage(
  raw: string | null,
  isProduct: (value: unknown) => value is DisplayProduct,
): FavoriteStore {
  const products = new Map<string, FavoriteProduct>();
  const legacyIds = new Set<number>();
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return { products, legacyIds };
    const entries: unknown[] = parsed;
    for (const entry of entries) {
      if (isProduct(entry)) {
        products.set(entry.key, favoriteSnapshot(entry));
        continue;
      }
      if (isRecord(entry)) {
        const migrated = migrateListingFavorite(entry);
        if (migrated) products.set(migrated.key, migrated);
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

/** What to persist: legacy ids first, then snapshots, matching the read order. */
export function favoriteStoragePayload(store: FavoriteStore): unknown[] {
  return [...store.legacyIds, ...store.products.values()];
}

/**
 * Client-side equivalent of the server's product filtering, applied to snapshots.
 *
 * `category_ids` carries the canonical leaf plus its ancestors, so a favorite under a group filter
 * follows the same closure semantics as `/api/product-search`. Older snapshots without that field
 * keep the leaf/display-label fallback. Offer-level filters use the saved detail observation or
 * representative offer; unconfirmed multi-shop candidates remain visible until refreshed.
 */
export function favoriteMatchesFilters(
  product: FavoriteProduct,
  filters: ProductFilters,
  categoryLabel: string,
  now = Date.now(),
): boolean {
  const terms = parseFtsSearchQuery(filters.q).terms;
  const searchable = normalizedSearchText(product);
  if (!terms.every((term) => searchable.includes(term.toLocaleLowerCase("ja-JP")))) return false;
  if (favoriteShopMatch(product, filters.shop, filters) === "missing") return false;
  if (filters.manufacturer.length && !filters.manufacturer.includes(product.manufacturer))
    return false;
  const categoryIds = stringArray(product.category_ids) ?? [];
  if (
    filters.category &&
    !categoryIds.includes(filters.category) &&
    product.primary_category_id !== filters.category &&
    product.category !== categoryLabel
  ) {
    return false;
  }
  if (filters.inStock && product.in_stock_offer_count < 1) return false;
  if (filters.recentOnly && !activityData(product, now).isNew) return false;
  if (filters.priceDropped && !priceDropped(product)) return false;
  // Shop, stock and price must hold for the same known offer. Incomplete candidates stay visible
  // with an explicit note until the user's bounded refresh can confirm or exclude them.
  if (filters.shop.length) return true;
  const minPrice = Number.parseInt(filters.minPrice, 10);
  // A null price coerces to 0 in the original relational comparison; `?? 0` keeps that.
  if (Number.isFinite(minPrice) && !((product.lowest_price_yen ?? 0) >= minPrice)) return false;
  const maxPrice = Number.parseInt(filters.maxPrice, 10);
  if (Number.isFinite(maxPrice) && !((product.lowest_price_yen ?? 0) <= maxPrice)) return false;
  return true;
}

/** Same score semantics as the persisted entity column, reconstructed from a favorite snapshot. */
function favoriteDealScore(product: DisplayProduct): number | null {
  const index = productPriceIndex(product);
  if (!index || index.asking_median_yen <= 0) return null;
  const offer = product.representative_offer;
  const current =
    offer?.stock_status === "in_stock" && offer.price_yen != null
      ? offer.price_yen
      : product.lowest_price_yen;
  if (current == null) return null;
  return Math.round(((current - index.asking_median_yen) * 10_000) / index.asking_median_yen);
}

/** Match the catalog's price, listing-date and activity sorts; unavailable values sort last. */
export function sortFavorites(products: DisplayProduct[], sort: string): DisplayProduct[] {
  const sorted = [...products];
  sorted.sort((left, right) => {
    if (sort === "dealScore") {
      const leftScore = favoriteDealScore(left);
      const rightScore = favoriteDealScore(right);
      if (leftScore == null && rightScore == null) return 0;
      if (leftScore == null) return 1;
      if (rightScore == null) return -1;
      return leftScore - rightScore;
    }
    if (sort === "priceAsc" || sort === "priceDesc") {
      if (left.lowest_price_yen == null && right.lowest_price_yen == null) return 0;
      if (left.lowest_price_yen == null) return 1;
      if (right.lowest_price_yen == null) return -1;
      return sort === "priceAsc"
        ? left.lowest_price_yen - right.lowest_price_yen
        : right.lowest_price_yen - left.lowest_price_yen;
    }
    if (sort === "newest" || sort === "oldest") {
      const leftDate = left.newest_listed_at ? safeDate(left.newest_listed_at) : null;
      const rightDate = right.newest_listed_at ? safeDate(right.newest_listed_at) : null;
      if (!leftDate && !rightDate) return 0;
      if (!leftDate) return 1;
      if (!rightDate) return -1;
      return sort === "oldest"
        ? leftDate.getTime() - rightDate.getTime()
        : rightDate.getTime() - leftDate.getTime();
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
