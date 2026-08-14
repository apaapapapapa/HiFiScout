/**
 * `/api` access plus the guards that turn an untrusted JSON response into a typed payload.
 *
 * Shared TypeScript contracts describe what the Worker *should* send; these guards are what the
 * browser actually trusts, so they stay even though both sides now compile against the same
 * types. The guards validate every field the UI subsequently reads instead of accepting a payload
 * merely because its top-level collections exist.
 */

import type {
  MetaCategoryFacet,
  MetaResponse,
  MetaShop,
  MetaShopSyncState,
  ProductListItem,
  ProductPricePoint,
  ShopHealthEntry,
  ShopHealthReason,
  ShopHealthStatus,
} from "../src/api/contracts.js";
import type { ProductHistoryResponse, ProductsResponse } from "./types.js";

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
    (value.sync === null || isMetaShopSyncState(value.sync)) &&
    (value.health === null || isShopHealthEntry(value.health))
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

function isProductListItem(value: unknown): value is ProductListItem {
  if (!isRecord(value)) return false;
  const stringFields = [
    "shop_key",
    "source_id",
    "manufacturer",
    "model",
    "title",
    "category",
    "condition_text",
    "source_url",
    "first_seen_at",
    "last_seen_at",
    "last_changed_at",
    "metadata_json",
    "raw_manufacturer",
    "manufacturer_id",
    "raw_category",
    "primary_category_id",
    "search_aliases",
  ] as const;
  if (!stringFields.every((field) => typeof value[field] === "string")) return false;

  return (
    isNonNegativeInteger(value.id) &&
    isNullableNumber(value.price_yen) &&
    (value.stock_status === "in_stock" ||
      value.stock_status === "sold_out" ||
      value.stock_status === "unknown") &&
    (value.is_active === 0 || value.is_active === 1) &&
    isNullableNumber(value.previous_price_yen) &&
    isStringArray(value.category_ids) &&
    (value.classification_status === "classified" ||
      value.classification_status === "unclassified") &&
    isNullableString(value.last_inventory_checked_at) &&
    isNonNegativeInteger(value.inventory_check_failures) &&
    isNullableString(value.last_inventory_check_attempt_at) &&
    isNullableString(value.last_activity_at) &&
    isNullableString(value.source_published_at)
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
    isStringArray(value.categories) &&
    Array.isArray(value.categoryFacets) &&
    value.categoryFacets.every(isMetaCategoryFacet)
  );
}

export function isProductsResponse(value: unknown): value is ProductsResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isProductListItem) ||
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

export function isProductHistoryResponse(value: unknown): value is ProductHistoryResponse {
  return (
    isRecord(value) &&
    isProductListItem(value.product) &&
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
