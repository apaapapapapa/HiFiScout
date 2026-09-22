import type { AuctionObservation, AuctionOffer } from "../api/auction-contracts.js";
import { auctionDisplayState } from "./observation.js";

/** Normalized public identity supplied by catalog resolution, never a fallback to raw seller text. */
export interface AuctionPublicIdentity {
  catalogProductId: number | null;
  manufacturer: string;
  model: string;
  categoryId: string;
}

/** Copy only public fields: type annotations alone cannot remove extra runtime properties. */
export function toAuctionOffer(
  observation: AuctionObservation,
  identity: AuctionPublicIdentity,
  now: number,
): AuctionOffer {
  return {
    source: observation.source,
    auctionId: observation.auctionId,
    sourceUrl: observation.sourceUrl,
    catalogProductId: identity.catalogProductId,
    manufacturer: identity.manufacturer,
    model: identity.model,
    categoryId: identity.categoryId,
    condition: observation.condition,
    saleSubject: observation.saleSubject,
    saleUnit: observation.saleUnit,
    currentPriceYen: observation.currentPriceYen,
    buyNowPriceStatus: observation.buyNowPriceStatus,
    buyNowPriceYen: observation.buyNowPriceYen,
    bidCount: observation.bidCount,
    taxStatus: observation.taxStatus,
    shipping: observation.shipping,
    scheduledEndAt: observation.scheduledEndAt,
    observedAt: observation.observedAt,
    priceObservedAt:
      observation.currentPriceYen !== null || observation.buyNowPriceYen !== null
        ? observation.observedAt
        : null,
    displayState: auctionDisplayState(observation, now),
  };
}
