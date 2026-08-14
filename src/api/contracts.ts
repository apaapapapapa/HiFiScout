/**
 * Cross-runtime HTTP contracts.
 *
 * These interfaces are the payloads the Worker serialises and the browser consumes. They are
 * deliberately **not** derived from the `*Row` persistence types in `db/types.ts`: a migration
 * that adds, renames or retypes a column must never silently change a public payload. Rows are
 * mapped onto these DTOs by explicit mappers at the repository boundary.
 *
 * The module is intentionally dependency-light — only type-only imports of the catalog domain —
 * so `frontend/` can consume it without pulling any server module into the browser bundle.
 *
 * These are compile-time contracts only. Runtime validation of untrusted input (HTTP responses,
 * localStorage, query strings) still belongs to the guards at each boundary.
 */

import type { ClassificationStatus, StockStatus } from "../catalog/types.js";

// ---------------------------------------------------------------------------
// /api/products
// ---------------------------------------------------------------------------

/** Accepted `?sort=` values. Part of the public query vocabulary, not a storage concern. */
export type ProductQuerySort = "newest" | "oldest" | "updated" | "priceAsc" | "priceDesc";

export const PRODUCT_QUERY_SORTS: readonly ProductQuerySort[] = [
  "newest",
  "oldest",
  "updated",
  "priceAsc",
  "priceDesc",
];

/**
 * One `/api/products` item.
 *
 * Field names stay snake_case because that is the shipped wire format; they mirror the current
 * columns by intent, not by construction. Changing this interface is an API change and must be
 * a deliberate edit here, not a side effect of a migration.
 */
export interface ProductListItem {
  id: number;
  shop_key: string;
  source_id: string;
  manufacturer: string;
  model: string;
  title: string;
  /** Free Japanese display label, not a category id. */
  category: string;
  condition_text: string;
  price_yen: number | null;
  stock_status: StockStatus;
  source_url: string;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string;
  /** Wire value of the SQLite boolean; the list endpoint only ever returns active products. */
  is_active: 0 | 1;
  previous_price_yen: number | null;
  /** JSON object serialised as a string; consumers parse to `unknown` then narrow. */
  metadata_json: string;
  raw_manufacturer: string;
  manufacturer_id: string;
  raw_category: string;
  primary_category_id: string;
  /** Already parsed into an array, unlike the stored JSON column. */
  category_ids: string[];
  classification_status: ClassificationStatus;
  search_aliases: string;
  last_inventory_checked_at: string | null;
  inventory_check_failures: number;
  last_inventory_check_attempt_at: string | null;
  last_activity_at: string | null;
  source_published_at: string | null;
}

/** `/api/products` response. `totalCount`/`totalPages` exist only when `includeTotal=true`. */
export interface ProductListResponse {
  items: ProductListItem[];
  hasMore: boolean;
  nextCursor: string | null;
  totalCount?: number | null;
  totalPages?: number;
}

// ---------------------------------------------------------------------------
// /api/products/:id/history
// ---------------------------------------------------------------------------

export interface ProductPricePoint {
  price_yen: number;
  observed_at: string;
}

export interface ProductHistoryResponse {
  product: ProductListItem;
  history: ProductPricePoint[];
}

// ---------------------------------------------------------------------------
// Shop sync health (shared by /api/meta and /api/health)
// ---------------------------------------------------------------------------

export type ShopHealthStatus = "disabled" | "healthy" | "warning" | "critical";

export type ShopHealthReason =
  | "disabled"
  | "configuration_missing"
  | "never_succeeded_repeated_failures"
  | "never_succeeded"
  | "repeated_failures"
  | "sync_stale"
  | "recent_failure"
  | "sync_delayed"
  | "ok";

export interface ShopHealthSummary {
  status: ShopHealthStatus;
  ageMinutes: number | null;
  reason: ShopHealthReason;
}

export interface ShopHealthEntry extends ShopHealthSummary {
  shopKey: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  intervalMinutes: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastItemCount: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface SyncHealthResponse {
  ok: boolean;
  status: ShopHealthStatus;
  checkedAt: string;
  shops: ShopHealthEntry[];
}

// ---------------------------------------------------------------------------
// /api/meta
// ---------------------------------------------------------------------------

/**
 * Crawl bookkeeping exposed per shop.
 *
 * Snake_case, and field-for-field identical to today's payload — but declared here so the
 * `shop_sync_state` schema and this contract can diverge without breaking the browser.
 */
export interface MetaShopSyncState {
  shop_key: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  backoff_until: string | null;
  last_error: string | null;
  last_item_count: number;
  queued_at: string | null;
}

export interface MetaShop {
  key: string;
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  sync: MetaShopSyncState | null;
  health: ShopHealthEntry | null;
}

export interface MetaCategoryFacet {
  id: string;
  parentId: string | null;
  order: number;
  classifiable: boolean;
  filterable: boolean;
  /** Child categories are indented with a full-width space for `<option>` rendering. */
  name: string;
  /** Reserved for `<optgroup>` rendering; the Worker currently always sends `null`. */
  group: string | null;
  activeProductCount: number;
}

export interface MetaResponse {
  status: ShopHealthStatus;
  shops: MetaShop[];
  manufacturers: string[];
  /** Display names of classifiable categories, for the legacy ungrouped `<select>` fallback. */
  categories: string[];
  categoryFacets: MetaCategoryFacet[];
}
