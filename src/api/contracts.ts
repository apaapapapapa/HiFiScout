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

import type { StockStatus } from "../catalog/types.js";

// ---------------------------------------------------------------------------
// seller listings (/api/products/:id/history)
// ---------------------------------------------------------------------------

/**
 * Accepted `?sort=` values. Part of the public query vocabulary, not a storage concern.
 *
 * The vocabulary survived the move to product-level search, but each value is now defined over
 * offer aggregates rather than one listing's columns — see `product-search-cursor.ts`.
 */
export type ProductQuerySort = "newest" | "oldest" | "updated" | "priceAsc" | "priceDesc";

export const PRODUCT_QUERY_SORTS: readonly ProductQuerySort[] = [
  "newest",
  "oldest",
  "updated",
  "priceAsc",
  "priceDesc",
];

/**
 * Public seller facts returned by the price-history endpoint.
 *
 * Raw source evidence, resolver/classification provenance, search aliases, and remediation metadata
 * intentionally do not belong to this DTO. Those fields remain queryable in D1/admin surfaces but
 * must not leak into an ordinary user-facing response merely because they share the `products` row.
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
  previous_price_yen: number | null;
  last_activity_at: string | null;
  source_published_at: string | null;
}

// ---------------------------------------------------------------------------
// /api/product-search
// ---------------------------------------------------------------------------

/**
 * Whether a result is a confirmed Knowledge Catalog product or a listing standing in for itself.
 *
 * `unresolved_listing` is not an error state and must stay visible: it is what keeps identity
 * coverage gaps from turning into products a user cannot find.
 */
export type ProductSearchIdentityKind = "catalog" | "unresolved_listing";

/**
 * One shop's factual offer for a product.
 *
 * Everything here is a seller observation and stays that way — nothing on this interface is
 * promoted to a canonical product fact for rendering convenience.
 */
export interface ProductOffer {
  /** `products.id`. Also the key for `/api/products/:id/history`. */
  listing_product_id: number;
  shop_key: string;
  source_url: string;
  title: string;
  condition_text: string;
  /** Canonical finish this shop listed, or `""`. One spelling per finish across every shop. */
  presentation_color: string;
  price_yen: number | null;
  previous_price_yen: number | null;
  stock_status: StockStatus;
  first_seen_at: string;
  last_seen_at: string;
  last_activity_at: string | null;
  source_published_at: string | null;
}

/**
 * One `/api/product-search` result: a product plus a summary of its live offers.
 *
 * `key` is the only identifier clients should route on. It is namespaced so a catalog id and a
 * listing id can never be mistaken for each other. The aggregate fields describe the offers that
 * satisfied the request's offer-level filters, so a card cannot contradict the filter that
 * produced it; `offer_count` is therefore a count of *matching* offers, not of all of them.
 */
export interface ProductSearchItem {
  key: string;
  identity_kind: ProductSearchIdentityKind;
  catalog_product_id: number | null;
  manufacturer: string;
  manufacturer_id: string;
  model: string;
  /**
   * Finishes the matching offers are in, in catalog order.
   *
   * The finish is not in `model` by design — that is what lets two colours of one product be one
   * card — so it is listed here for the card to render beside the name. Optional only for
   * pre-colour favorite snapshots.
   */
  presentation_colors?: string[];
  primary_category_id: string;
  /** Canonical leaf plus its ancestor ids. Optional only for pre-Phase-4 favorite snapshots. */
  category_ids?: string[];
  /** Japanese display label for `primary_category_id`; empty when the id is unknown. */
  category: string;
  offer_count: number;
  in_stock_offer_count: number;
  /** Explicitly sold-out matching offers; distinguishes sold out from unknown availability. */
  sold_out_offer_count: number;
  shop_count: number;
  lowest_price_yen: number | null;
  highest_price_yen: number | null;
  latest_activity_at: string | null;
  /** Newest `source_published_at`/`first_seen_at` across matching offers. */
  newest_listed_at: string | null;
  has_new_offer: boolean;
  has_price_drop: boolean;
  /** Cheapest in-stock matching offer, for compact rendering. Null only if offers vanished. */
  representative_offer: ProductOffer | null;
}

/** `/api/product-search` response. `totalCount`/`totalPages` exist only when `includeTotal=true`. */
export interface ProductSearchResponse {
  items: ProductSearchItem[];
  hasMore: boolean;
  nextCursor: string | null;
  totalCount?: number | null;
  totalPages?: number;
}

/** `/api/product-search/:key`: the product plus every eligible active offer under it. */
export interface ProductSearchDetailResponse {
  product: ProductSearchItem;
  offers: ProductOffer[];
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
  | "projection_stale"
  | "projection_delayed"
  | "ok";

export interface ShopHealthSummary {
  status: ShopHealthStatus;
  ageMinutes: number | null;
  reason: ShopHealthReason;
  /**
   * Minutes since this shop's derived work was last fully complete, when that trails its inventory.
   *
   * Null when the projection is level with the last successful crawl. A number here means search
   * and identity are still catching up: ordinary for a few minutes after a crawl deferred its
   * remaining chunks, and evidence of a stuck stage when it keeps growing.
   */
  projectionAgeMinutes: number | null;
}

export interface ShopHealthEntry extends ShopHealthSummary {
  shopKey: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  intervalMinutes: number;
  lastSuccessAt: string | null;
  lastProjectionAt: string | null;
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
  /** When the shop's derived work was last fully complete; trails `last_success_at` while owed. */
  last_projection_at: string | null;
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
