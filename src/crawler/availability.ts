import type { StockStatus } from "../catalog/types.js";

/**
 * Canonical seller availability used by listing parsers and detail-page rechecks.
 *
 * `unknown` is intentional evidence, not a fallback for parser success. It covers absent,
 * contradictory, negotiating, or otherwise non-conclusive seller signals while keeping the
 * persisted/search vocabulary compatible with the existing D1 constraint.
 */
export interface AvailabilitySignals {
  readonly soldOut?: boolean;
  readonly inStock?: boolean;
  readonly defaultStatus?: StockStatus;
}

export function availabilityFromSignals({
  soldOut = false,
  inStock = false,
  defaultStatus = "unknown",
}: AvailabilitySignals): StockStatus {
  if (soldOut && inStock) return "unknown";
  if (soldOut) return "sold_out";
  if (inStock) return "in_stock";
  return defaultStatus;
}

export function availabilityFromText(text: string): StockStatus {
  const value = text.toLowerCase();
  const soldOut =
    /売り切れ|売切|売約済(?:み)?|sold\s*out|販売終了|ご成約|在庫なし|完売|品切れ/.test(value);
  const inStock = /在庫あり|in\s*stock|カートに入れる|購入する/.test(value);
  return availabilityFromSignals({ soldOut, inStock });
}
