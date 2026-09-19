/** Factual auction observations; deliberately independent of retail prices and stock. */
export interface AuctionObservation {
  source: "yahoo-auctions";
  auctionId: string;
  sourceUrl: string;
  title: string;
  rawManufacturer: string;
  rawModel: string;
  sourceCategoryId: string;
  rawCategoryPath: string;
  condition: "new" | "used" | "junk" | "unknown";
  saleSubject: "product" | "accessory" | "parts" | "empty_box" | "bundle" | "unknown";
  saleUnit: "single" | "pair" | "set" | "unknown";
  currentPriceYen: number | null;
  buyNowPriceYen: number | null;
  bidCount: number | null;
  taxStatus: "included" | "excluded" | "unknown";
  shipping: "free" | "additional" | "collect" | "unknown";
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

export interface AuctionOffer extends AuctionObservation {
  catalogProductId: number | null;
  manufacturer: string;
  model: string;
  categoryId: string;
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
