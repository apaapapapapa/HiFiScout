import type {
  AuctionOffer,
  AuctionOfferBuyNowPrice,
  AuctionOfferFact,
  AuctionOfferPrice,
} from "../api/auction-contracts.js";
import type { AuctionObservedFact, AuctionPrice, AuctionSnapshot } from "./types.js";
import { auctionPresentation } from "./observations.js";

/** Normalized catalog identity, never an automatic fallback to raw seller text. */
export interface AuctionPublicIdentity {
  catalogProductId: number | null;
  manufacturer: string;
  model: string;
  categoryId: string;
}

function publicFact<T extends string | number>(
  fact: AuctionObservedFact<T> | null,
): AuctionOfferFact<T> | null {
  return fact === null ? null : { value: fact.value, observedAt: fact.observedAt };
}

function publicPrice(price: AuctionPrice, observedAt: string): AuctionOfferPrice {
  return { amountYen: price.amountYen, tax: price.tax, observedAt };
}

function publicBuyNowPrice(
  fact: AuctionObservedFact<AuctionPrice | null> | null,
): AuctionOfferBuyNowPrice {
  if (fact === null) return { status: "unknown" };
  if (fact.value === null) return { status: "none", observedAt: fact.observedAt };
  return { status: "set", price: publicPrice(fact.value, fact.observedAt) };
}

/** Copy approved public fields at every nesting level; type annotations do not strip properties. */
export function toAuctionOffer(
  snapshot: AuctionSnapshot,
  identity: AuctionPublicIdentity,
  now: string,
  maxAgeMs = 2 * 60 * 60_000,
): AuctionOffer {
  const presentation = auctionPresentation(snapshot, now, maxAgeMs);
  const current = snapshot.live.currentPrice;
  return {
    source: snapshot.source,
    auctionId: snapshot.auctionId,
    sourceUrl: snapshot.sourceUrl,
    catalogProductId: identity.catalogProductId,
    manufacturer: identity.manufacturer,
    model: identity.model,
    categoryId: identity.categoryId,
    saleSubject: snapshot.item.saleSubject,
    saleUnit: snapshot.item.saleUnit,
    currentPrice: current ? publicPrice(current.value, current.observedAt) : null,
    buyNowPrice: publicBuyNowPrice(snapshot.live.buyNowPrice),
    bidCount: publicFact(snapshot.live.bidCount),
    shipping: publicFact(snapshot.live.shipping),
    scheduledEndAt: publicFact(snapshot.live.scheduledEndAt),
    observedAt: snapshot.stamp.observedAt,
    displayState: presentation.phase,
    freshness: presentation.freshness,
  };
}
