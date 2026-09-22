/** Auction observations are not retail offers or confirmed transaction prices. */
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

export interface AuctionPrice {
  amountYen: number;
  tax: AuctionTax;
}

export interface AuctionObservedFact<T> {
  value: T;
  /** Fetch observation time, not parsing/replay time. */
  observedAt: string;
}

/** An outer null is unobserved; buyNowPrice.value=null is an explicit absence. */
export interface AuctionLiveFacts {
  currentPrice: AuctionObservedFact<AuctionPrice> | null;
  buyNowPrice: AuctionObservedFact<AuctionPrice | null> | null;
  bidCount: AuctionObservedFact<number> | null;
  scheduledEndAt: AuctionObservedFact<string> | null;
  startedAt: AuctionObservedFact<string> | null;
  sourceState: AuctionObservedFact<AuctionSourceState> | null;
  outcome: AuctionObservedFact<AuctionOutcome> | null;
  shipping: AuctionObservedFact<AuctionShipping> | null;
}

export interface AuctionItemFacts {
  title: string;
  rawManufacturer: string | null;
  rawModel: string | null;
  sourceCategoryId: string;
  sourceCategoryPath: readonly string[];
  rawCategory: string;
  /** Corroborative only; neither a canonical category nor a product identity. */
  categoryHint: string;
  conditionText: string | null;
  saleUnit: AuctionSaleUnit;
  saleSubject: AuctionSaleSubject;
}

/** Issued by the owning scheduler, never taken from seller-controlled markup. */
export interface AuctionObservationStamp {
  generation: number;
  sequence: number;
  observedAt: string;
}

export interface AuctionObservation {
  source: "yahoo-auctions";
  auctionId: string;
  sourceUrl: string;
  stamp: AuctionObservationStamp;
  item: AuctionItemFacts;
  live: AuctionLiveFacts;
}

export interface AuctionSnapshot extends AuctionObservation {
  cycle: number;
}

export interface AuctionParseResult {
  status: "parsed" | "partial" | "unsupported";
  /** A listing page is never a complete inventory snapshot. */
  coverage: "partial" | "unknown";
  observations: AuctionObservation[];
  issues: string[];
}

/** No transport, persistence or discovery occurs inside this exchangeable boundary. */
export interface YahooAuctionSource {
  readonly key: "yahoo-auctions";
  parse(input: unknown, context: unknown): AuctionParseResult;
}
