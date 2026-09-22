import type { AuctionObservation } from "../../src/api/auction-contracts.js";

/** Synthetic contract fixture, not evidence that a live source parser is validated. */
export function auctionFixture(changes: Partial<AuctionObservation> = {}): AuctionObservation {
  return {
    source: "yahoo-auctions",
    auctionId: "a1234567890",
    sourceUrl: "https://auctions.yahoo.co.jp/jp/auction/a1234567890",
    title: "Example Model II ペア",
    rawManufacturer: "Example",
    rawModel: "Model II",
    sourceCategoryId: "23764",
    rawCategoryPath: "オーディオ機器",
    condition: "unknown",
    saleSubject: "unknown",
    saleUnit: "pair",
    currentPriceYen: 1,
    buyNowPriceStatus: "unknown",
    buyNowPriceYen: null,
    bidCount: 0,
    taxStatus: "unknown",
    shipping: "unknown",
    sourceStatus: "active",
    sourceStartedAt: "2026-09-18T00:00:00.000Z",
    scheduledEndAt: "2026-09-19T12:00:00.000Z",
    requestedAt: "2026-09-19T10:00:00.000Z",
    observedAt: "2026-09-19T10:00:01.000Z",
    ...changes,
  };
}
