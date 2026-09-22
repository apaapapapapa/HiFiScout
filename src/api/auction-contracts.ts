export type AuctionCondition = "new" | "used" | "junk" | "unknown";
export type AuctionSaleSubject =
  | "product"
  | "accessory"
  | "parts"
  | "empty_box"
  | "bundle"
  | "unknown";
export type AuctionSaleUnit = "single" | "pair" | "set" | "unknown";
export type AuctionTaxStatus = "included" | "excluded" | "unknown";
export type AuctionShipping = "free" | "additional" | "collect" | "unknown";
/** `none` requires explicit source evidence; missing information remains `unknown`. */
export type AuctionBuyNowPriceStatus = "set" | "none" | "unknown";

/** Retained source observations; never serialize this shape as a public response. */
export interface AuctionObservation {
  source: "yahoo-auctions";
  auctionId: string;
  sourceUrl: string;
  title: string;
  rawManufacturer: string;
  rawModel: string;
  sourceCategoryId: string;
  rawCategoryPath: string;
  condition: AuctionCondition;
  saleSubject: AuctionSaleSubject;
  saleUnit: AuctionSaleUnit;
  currentPriceYen: number | null;
  buyNowPriceStatus: AuctionBuyNowPriceStatus;
  buyNowPriceYen: number | null;
  bidCount: number | null;
  taxStatus: AuctionTaxStatus;
  shipping: AuctionShipping;
  sourceStatus: "active" | "ended" | "unavailable" | "unknown";
  sourceStartedAt: string | null;
  scheduledEndAt: string | null;
  requestedAt: string;
  observedAt: string;
}

export type AuctionDisplayState =
  | "active"
  | "stale"
  | "end_confirmation_pending"
  | "ended"
  | "unavailable"
  | "unknown";

/** Explicit public facts, independent of retained seller text and future observation fields. */
export interface AuctionOffer {
  source: "yahoo-auctions";
  auctionId: string;
  sourceUrl: string;
  catalogProductId: number | null;
  manufacturer: string;
  model: string;
  categoryId: string;
  condition: AuctionCondition;
  saleSubject: AuctionSaleSubject;
  saleUnit: AuctionSaleUnit;
  currentPriceYen: number | null;
  buyNowPriceStatus: AuctionBuyNowPriceStatus;
  buyNowPriceYen: number | null;
  bidCount: number | null;
  taxStatus: AuctionTaxStatus;
  shipping: AuctionShipping;
  scheduledEndAt: string | null;
  observedAt: string;
  priceObservedAt: string | null;
  displayState: AuctionDisplayState;
}

export interface AuctionSearchResult {
  items: AuctionOffer[];
  nextCursor: string | null;
  observedAt: string;
  coverage: "partial" | "unknown";
}

export type AuctionControlAction = "status" | "pause" | "resume" | "run" | "reconcile";

export interface AuctionAdminStatus {
  collectionEnabled: boolean;
  searchEnabled: boolean;
  publicEnabled: boolean;
  paused: boolean;
  blockers: string[];
  nextAlarmAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  trackedItems: number | null;
  usage: {
    day: string;
    sellerRequests: number;
    rowsRead: number;
    rowsWritten: number;
    coverage: "local_only";
  } | null;
}
