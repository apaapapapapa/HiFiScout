/**
 * `/api` access plus the guards that turn an untrusted JSON response into a typed payload.
 *
 * Shared TypeScript contracts describe what the Worker *should* send; these guards are what the
 * browser actually trusts, so they stay even though both sides now compile against the same
 * types. The guards validate every field the UI subsequently reads instead of accepting a payload
 * merely because its top-level collections exist.
 */

import { MAX_SUGGESTIONS, MAX_SUGGEST_QUERY_LENGTH } from "../src/api/contracts.js";
import type {
  MetaCategoryFacet,
  MetaManufacturerFacet,
  MetaResponse,
  MetaShop,
  MetaShopSyncState,
  ProductOffer,
  ProductPricePoint,
  ProductSearchItem,
  ShopHealthEntry,
  ShopHealthReason,
  ShopHealthStatus,
  SuggestResponse,
} from "../src/api/contracts.js";
import type { ProductDetailResponse, ProductHistoryResponse, ProductsResponse } from "./types.js";

/** Matches the Worker's own `cache-control: public, max-age=30` on these endpoints. */
const CACHE_TTL_MS = 30_000;

interface CachedResponse {
  data: unknown;
  expiresAt: number;
}

const SHOP_HEALTH_STATUSES: readonly ShopHealthStatus[] = [
  "disabled",
  "healthy",
  "warning",
  "critical",
];
const SHOP_HEALTH_REASONS: readonly ShopHealthReason[] = [
  "disabled",
  "configuration_missing",
  "never_succeeded_repeated_failures",
  "never_succeeded",
  "repeated_failures",
  "sync_stale",
  "recent_failure",
  "sync_delayed",
  "ok",
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isShopHealthStatus(value: unknown): value is ShopHealthStatus {
  return SHOP_HEALTH_STATUSES.includes(value as ShopHealthStatus);
}

function isShopHealthReason(value: unknown): value is ShopHealthReason {
  return SHOP_HEALTH_REASONS.includes(value as ShopHealthReason);
}

function isShopHealthEntry(value: unknown): value is ShopHealthEntry {
  return (
    isRecord(value) &&
    typeof value.shopKey === "string" &&
    typeof value.name === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.configured === "boolean" &&
    isNonNegativeInteger(value.intervalMinutes) &&
    isShopHealthStatus(value.status) &&
    isNullableNumber(value.ageMinutes) &&
    isShopHealthReason(value.reason) &&
    isNullableString(value.lastSuccessAt) &&
    isNullableString(value.lastAttemptAt) &&
    isNullableNumber(value.lastItemCount) &&
    isNonNegativeInteger(value.consecutiveFailures) &&
    isNullableString(value.lastError)
  );
}

function isMetaShopSyncState(value: unknown): value is MetaShopSyncState {
  return (
    isRecord(value) &&
    typeof value.shop_key === "string" &&
    isNullableString(value.last_attempt_at) &&
    isNullableString(value.last_success_at) &&
    isNullableString(value.last_error_at) &&
    isNonNegativeInteger(value.consecutive_failures) &&
    isNullableString(value.backoff_until) &&
    isNullableString(value.last_error) &&
    isNonNegativeInteger(value.last_item_count) &&
    isNullableString(value.queued_at)
  );
}

function isMetaShop(value: unknown): value is MetaShop {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.name === "string" &&
    typeof value.enabled === "boolean" &&
    isNonNegativeInteger(value.intervalMinutes) &&
    (value.activeProductCount === undefined || isNonNegativeInteger(value.activeProductCount)) &&
    (value.sync === null || isMetaShopSyncState(value.sync)) &&
    (value.health === null || isShopHealthEntry(value.health))
  );
}

function isMetaManufacturerFacet(value: unknown): value is MetaManufacturerFacet {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isNonNegativeInteger(value.activeProductCount)
  );
}

function isMetaCategoryFacet(value: unknown): value is MetaCategoryFacet {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isNullableString(value.parentId) &&
    isNonNegativeInteger(value.order) &&
    typeof value.classifiable === "boolean" &&
    typeof value.filterable === "boolean" &&
    typeof value.name === "string" &&
    isNullableString(value.group) &&
    isNonNegativeInteger(value.activeProductCount)
  );
}

export function isProductOffer(value: unknown): value is ProductOffer {
  if (!isRecord(value)) return false;
  const stringFields = [
    "shop_key",
    "source_url",
    "title",
    "condition_text",
    "first_seen_at",
    "last_seen_at",
  ] as const;
  if (!stringFields.every((field) => typeof value[field] === "string")) return false;
  // Optional for the same reason `category_ids` is: a favorite stored by an older build predates
  // the field, and discarding the card over a finish label would lose the user's favorite.
  if (value.presentation_color !== undefined && typeof value.presentation_color !== "string") {
    return false;
  }

  return (
    isNonNegativeInteger(value.listing_product_id) &&
    isNullableNumber(value.price_yen) &&
    isNullableNumber(value.previous_price_yen) &&
    (value.stock_status === "in_stock" ||
      value.stock_status === "sold_out" ||
      value.stock_status === "unknown") &&
    isNullableString(value.last_activity_at) &&
    isNullableString(value.source_published_at)
  );
}

/**
 * Validates every field the product card reads, including the nested representative offer.
 *
 * Also the gate for favorites restored from localStorage, so a hand-edited or half-migrated entry
 * is discarded rather than rendered as a product.
 */
export function isProductSearchItem(value: unknown): value is ProductSearchItem {
  if (!isRecord(value)) return false;
  const stringFields = [
    "key",
    "manufacturer",
    "manufacturer_id",
    "model",
    "primary_category_id",
    "category",
  ] as const;
  if (!stringFields.every((field) => typeof value[field] === "string")) return false;
  if (!value.key) return false;
  if (value.presentation_colors !== undefined && !isStringArray(value.presentation_colors)) {
    return false;
  }

  return (
    (value.identity_kind === "catalog" || value.identity_kind === "unresolved_listing") &&
    (value.catalog_product_id === null || isNonNegativeInteger(value.catalog_product_id)) &&
    isNonNegativeInteger(value.offer_count) &&
    isNonNegativeInteger(value.in_stock_offer_count) &&
    isNonNegativeInteger(value.sold_out_offer_count) &&
    isNonNegativeInteger(value.shop_count) &&
    isNullableNumber(value.lowest_price_yen) &&
    isNullableNumber(value.highest_price_yen) &&
    isNullableString(value.latest_activity_at) &&
    isNullableString(value.newest_listed_at) &&
    typeof value.has_new_offer === "boolean" &&
    typeof value.has_price_drop === "boolean" &&
    (value.representative_offer === null || isProductOffer(value.representative_offer))
  );
}

function isProductPricePoint(value: unknown): value is ProductPricePoint {
  return (
    isRecord(value) && isFiniteNumber(value.price_yen) && typeof value.observed_at === "string"
  );
}

export function isMetaResponse(value: unknown): value is MetaResponse {
  return (
    isRecord(value) &&
    isShopHealthStatus(value.status) &&
    Array.isArray(value.shops) &&
    value.shops.every(isMetaShop) &&
    isStringArray(value.manufacturers) &&
    (value.manufacturerFacets === undefined ||
      (Array.isArray(value.manufacturerFacets) &&
        value.manufacturerFacets.every(isMetaManufacturerFacet))) &&
    isStringArray(value.categories) &&
    Array.isArray(value.categoryFacets) &&
    value.categoryFacets.every(isMetaCategoryFacet)
  );
}

export function isSuggestResponse(value: unknown): value is SuggestResponse {
  return (
    isRecord(value) &&
    isStringArray(value.suggestions) &&
    value.suggestions.length <= MAX_SUGGESTIONS &&
    value.suggestions.every((suggestion) => [...suggestion].length <= MAX_SUGGEST_QUERY_LENGTH)
  );
}

export function isProductsResponse(value: unknown): value is ProductsResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isProductSearchItem) ||
    typeof value.hasMore !== "boolean" ||
    !isNullableString(value.nextCursor)
  ) {
    return false;
  }
  if (
    "totalCount" in value &&
    value.totalCount !== null &&
    !isNonNegativeInteger(value.totalCount)
  ) {
    return false;
  }
  return !("totalPages" in value) || isNonNegativeInteger(value.totalPages);
}

export function isProductDetailResponse(value: unknown): value is ProductDetailResponse {
  return (
    isRecord(value) &&
    isProductSearchItem(value.product) &&
    Array.isArray(value.offers) &&
    value.offers.every(isProductOffer)
  );
}

/**
 * Price history stays a seller-listing view, so only the labels the dialog prints are validated.
 * Widening this to the whole listing contract would recouple the browser to a shape it stopped
 * rendering when cards became products.
 */
export function isProductHistoryResponse(value: unknown): value is ProductHistoryResponse {
  return (
    isRecord(value) &&
    isRecord(value.product) &&
    typeof value.product.manufacturer === "string" &&
    typeof value.product.model === "string" &&
    typeof value.product.title === "string" &&
    Array.isArray(value.history) &&
    value.history.every(isProductPricePoint)
  );
}

/**
 * Short-lived in-memory response cache.
 *
 * Paging back and forth re-requests the same URLs, and the entries are per-tab and expire, so a
 * stale price is bounded by {@link CACHE_TTL_MS} rather than by the session.
 */
export function createApiClient(fetchImpl: typeof fetch = fetch, ttlMs = CACHE_TTL_MS) {
  const cache = new Map<string, CachedResponse>();

  return {
    async fetchJson(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
      const cached = cache.get(url);
      if (cached && cached.expiresAt > Date.now()) return cached.data;
      if (cached) cache.delete(url);

      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: unknown = await response.json();
      cache.set(url, { data, expiresAt: Date.now() + ttlMs });
      return data;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
