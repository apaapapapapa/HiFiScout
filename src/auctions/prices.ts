import type { AuctionPrice } from "./types.js";

/**
 * A confirmed tax-inclusive or explicitly tax-exempt item price is comparable. Unknown tax and
 * tax-exclusive amounts retain their source value, but cannot authorize a guessed gross price.
 * Shipping/fees and per-piece conversions are deliberately outside this comparison.
 */
export function auctionComparablePriceYen(price: AuctionPrice | null | undefined): number | null {
  if (
    !price ||
    !Number.isSafeInteger(price.amountYen) ||
    price.amountYen < 0 ||
    (price.tax !== "inclusive" && price.tax !== "exempt")
  )
    return null;
  return price.amountYen;
}

/** Same-price ties require a stable listing ID at the query boundary, not a fabricated price. */
export function compareAuctionPrices(
  left: AuctionPrice | null | undefined,
  right: AuctionPrice | null | undefined,
  direction: "asc" | "desc",
): number {
  const leftYen = auctionComparablePriceYen(left);
  const rightYen = auctionComparablePriceYen(right);
  if (leftYen === null) return rightYen === null ? 0 : 1;
  if (rightYen === null) return -1;
  const comparison = leftYen === rightYen ? 0 : leftYen < rightYen ? -1 : 1;
  return direction === "asc" ? comparison : -comparison;
}

/** An inactive range keeps unknown prices; an actual price filter never matches an unknown. */
export function auctionPriceMatchesRange(
  price: AuctionPrice | null | undefined,
  minimumYen: number | null,
  maximumYen: number | null,
): boolean {
  if (
    [minimumYen, maximumYen].some(
      (bound) => bound !== null && (!Number.isSafeInteger(bound) || bound < 0),
    ) ||
    (minimumYen !== null && maximumYen !== null && minimumYen > maximumYen)
  )
    throw new Error("Invalid auction price range");
  if (minimumYen === null && maximumYen === null) return true;
  const comparable = auctionComparablePriceYen(price);
  return (
    comparable !== null &&
    (minimumYen === null || comparable >= minimumYen) &&
    (maximumYen === null || comparable <= maximumYen)
  );
}
