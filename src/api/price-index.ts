/** Public Knowledge Catalog market-price summary projected onto product-search responses. */

/**
 * Minimum independent listings with retained asking-price evidence required before the public API exposes a price index.
 *
 * A named threshold keeps Step 4 badge logic mechanical: `price_index` exists only when the
 * evidence floor is met, so low-sample products never need a second client-side policy.
 */
export const PRODUCT_PRICE_INDEX_MIN_ASKING_SAMPLES = 3;

export type ProductPriceIndexListingEndSignal = "sold_out" | "deactivated";

/** One bounded, factual observation captured when a listing ended or was explicitly sold out. */
export interface ProductPriceIndexListingEndObservation {
  price_yen: number;
  observed_at: string;
  signal_kind: ProductPriceIndexListingEndSignal;
}

export interface ProductPriceIndexSummary {
  /** Retained observation count; price changes do not increase the independent listing count. */
  asking_sample_count: number;
  asking_listing_count?: number;
  asking_shop_count?: number;
  latest_asking_observed_at?: string | null;
  asking_median_yen: number;
  asking_min_yen: number;
  asking_max_yen: number;
  /** Median of each listing's latest quote within 90 days, maintained by background projections. */
  recent_asking_median_yen: number | null;
  listing_end_sample_count: number;
  listing_end_median_yen: number | null;
  /** Explicitly observed seller `sold_out` evidence; stronger than generic disappearance. */
  sold_out_signal_count: number;
  /** Generic deactivation/disappearance evidence; kept separate from explicit sold-out signals. */
  deactivated_signal_count: number;
  /**
   * Most recent price-bearing listing-end observations. Detail-only and bounded by the API so
   * ordinary search pages do not carry a historical-event payload they never render.
   */
  listing_end_observations?: ProductPriceIndexListingEndObservation[];
  /** Timestamp at which this API projection was calculated. */
  last_computed_at: string;
}
