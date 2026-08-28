/**
 * Browser-side views of the server contracts.
 *
 * `src/api/contracts.ts` states what the Worker sends. This module states what the browser is
 * willing to assume after its runtime guards have run.
 *
 * Since Phase 4 the rendered unit is a product with offers, not a seller listing, and favorites are
 * validated by the same guard as API results — so one type flows through rendering whether a card
 * came from `/api/product-search` or from localStorage. Favorites written by the previous,
 * listing-shaped build are migrated at read time rather than being reinterpreted in place; see
 * `favorites.ts`.
 */

import type {
  MetaShop,
  ProductOffer,
  ProductPricePoint,
  ProductSearchItem,
  ProductSearchResponse,
} from "../src/api/contracts.js";

export type DisplayPriceIndexListingEndSignal = "sold_out" | "deactivated";

export interface DisplayPriceIndexListingEndObservation {
  price_yen: number;
  observed_at: string;
  signal_kind: DisplayPriceIndexListingEndSignal;
}

/** Browser-validated view of the optional Step 3 price-index projection. */
export interface DisplayPriceIndexSummary {
  asking_sample_count: number;
  asking_median_yen: number;
  asking_min_yen: number;
  asking_max_yen: number;
  recent_asking_median_yen: number | null;
  listing_end_sample_count: number;
  listing_end_median_yen: number | null;
  sold_out_signal_count: number;
  deactivated_signal_count: number;
  listing_end_observations: DisplayPriceIndexListingEndObservation[];
  last_computed_at: string;
}

/**
 * A rendered product. Step 3 adds the price index at the repository boundary, so the browser widens
 * the base shared contract with the same optional field while older favorite snapshots stay valid.
 */
export type DisplayProduct = ProductSearchItem & { price_index?: DisplayPriceIndexSummary };

/** One shop's offer under a product. */
export type DisplayOffer = ProductOffer;

export interface ProductsResponse extends Omit<ProductSearchResponse, "items"> {
  items: DisplayProduct[];
}

export interface ProductDetailResponse {
  product: DisplayProduct;
  offers: DisplayOffer[];
}

export type PriceHistoryEntry = ProductPricePoint;

/** `/api/products/:id/history` stays listing-scoped: history belongs to one shop's offer. */
export interface ProductHistoryResponse {
  product: {
    manufacturer: string;
    model: string;
    title: string;
  };
  history: PriceHistoryEntry[];
}

/** One fetched page of results, kept so page navigation can replay without a request. */
export interface PageState {
  items: DisplayProduct[];
  hasMore: boolean;
  nextCursor: string | null;
}

export type ShopIndex = Record<string, MetaShop>;
