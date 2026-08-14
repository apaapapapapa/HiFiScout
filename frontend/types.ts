/**
 * Browser-side views of the server contracts.
 *
 * `src/api/contracts.ts` states what the Worker sends. This module states what the browser is
 * willing to assume after its runtime guards have run — which is deliberately weaker, because
 * `/api/products` items and localStorage favorites flow through the same rendering code and the
 * latter were written by an older version of this app.
 */

import type {
  MetaShop,
  ProductListItem,
  ProductListResponse,
  ProductPricePoint,
} from "../src/api/contracts.js";

type Nullable<T> = { [K in keyof T]: T[K] | null };

/** The `/api/products` fields this UI renders. The rest of the contract is ignored here. */
export type DisplayFields = Pick<
  ProductListItem,
  | "id"
  | "shop_key"
  | "manufacturer"
  | "manufacturer_id"
  | "raw_manufacturer"
  | "model"
  | "title"
  | "category"
  | "raw_category"
  | "primary_category_id"
  | "condition_text"
  | "price_yen"
  | "previous_price_yen"
  | "stock_status"
  | "source_url"
  | "first_seen_at"
  | "last_seen_at"
  | "last_changed_at"
  | "last_activity_at"
  | "search_aliases"
  | "category_ids"
>;

/**
 * Shape shared by rendered products and the favorite snapshots persisted in localStorage.
 * `favoriteSnapshot()` stores `null` for every missing field, so both sources expose the same
 * keys with nullable values. Field *types* still come from the contract, so a server-side change
 * to one of them breaks this build.
 */
export type DisplayProduct = Nullable<Omit<DisplayFields, "category_ids">> & {
  category_ids: string[];
};

/**
 * `/api/products` as the browser treats it: `isProductsResponse()` only validates `items`, so
 * item fields stay nullable even though the contract declares them populated.
 */
export interface ProductsResponse extends Omit<ProductListResponse, "items"> {
  items: DisplayProduct[];
}

export type PriceHistoryEntry = ProductPricePoint;

export interface ProductHistoryResponse {
  product: DisplayProduct;
  history: PriceHistoryEntry[];
}

/** One fetched page of the listing, kept so page navigation can replay without a request. */
export interface PageState {
  items: DisplayProduct[];
  hasMore: boolean;
  nextCursor: string | null;
}

export type ShopIndex = Record<string, MetaShop>;
