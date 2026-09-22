export type AuctionSourceState = "open" | "ended" | "unavailable" | "unknown";
export type AuctionOutcome = "winner_reported" | "no_winner_reported" | "unknown";
export type AuctionTax = "inclusive" | "exclusive" | "exempt" | "unknown";
export type AuctionShipping = "free" | "separate" | "collect" | "unknown";
export type AuctionSaleUnit = "single" | "pair" | "set" | "unknown";
export type AuctionSaleSubject =
  | "main_unit"
  | "accessory"
  | "parts"
  | "empty_box"
  | "bundle"
  | "unknown";

/** Public factual vocabulary only; never inherit the retained observation or item shape. */
export interface AuctionOfferFact<T extends string | number> {
  value: T;
  observedAt: string;
}

export interface AuctionOfferPrice {
  amountYen: number;
  tax: AuctionTax;
  observedAt: string;
}

/** Explicit absence has evidence; unobserved availability has no invented observation time. */
export type AuctionOfferBuyNowPrice =
  | { status: "unknown" }
  | { status: "none"; observedAt: string }
  | { status: "set"; price: AuctionOfferPrice };

export type AuctionDisplayState = AuctionSourceState | "end_check_pending";

/** Explicit public fields, independent of raw seller text and future persistence properties. */
export interface AuctionOffer {
  source: "yahoo-auctions";
  auctionId: string;
  sourceUrl: string;
  catalogProductId: number | null;
  manufacturer: string;
  model: string;
  categoryId: string;
  saleSubject: AuctionSaleSubject;
  saleUnit: AuctionSaleUnit;
  currentPrice: AuctionOfferPrice | null;
  buyNowPrice: AuctionOfferBuyNowPrice;
  bidCount: AuctionOfferFact<number> | null;
  shipping: AuctionOfferFact<AuctionShipping> | null;
  scheduledEndAt: AuctionOfferFact<string> | null;
  observedAt: string;
  displayState: AuctionDisplayState;
  freshness: "fresh" | "stale" | "unknown";
  freshUntil: string | null;
}

export interface AuctionSearchResult {
  items: AuctionOffer[];
  nextCursor: string | null;
  hasMore: boolean;
  observedAt: string;
  validUntil: string;
  coverage: "partial" | "unknown";
}
