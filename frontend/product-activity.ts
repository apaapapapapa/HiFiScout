/**
 * Freshness and price-drop derivation.
 *
 * `now` is a parameter rather than an implicit `Date.now()` so the 48-hour boundaries can be
 * tested exactly instead of approximately.
 */

import { safeDate } from "./format.js";
import type { DisplayProduct } from "./types.js";

const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface ActivityData {
  activity: Date | null;
  isNew: boolean;
  isRecentlyUpdated: boolean;
  label: string;
}

/**
 * A listing is NEW for 48 hours after first discovery, and UPDATED for 48 hours after a later
 * change — never both, so a freshly discovered product that changes immediately still reads as
 * new rather than flipping badge.
 */
export function activityData(product: DisplayProduct, now = Date.now()): ActivityData {
  const firstSeen = safeDate(product.first_seen_at);
  const activityValue = product.last_activity_at || product.first_seen_at || product.last_seen_at;
  const activity = safeDate(activityValue);
  const isNew = Boolean(firstSeen && now - firstSeen.getTime() < RECENT_WINDOW_MS);
  const hasBeenUpdated = Boolean(activity && firstSeen && activity.getTime() > firstSeen.getTime());
  const isRecentlyUpdated = Boolean(
    !isNew && hasBeenUpdated && activity && now - activity.getTime() < RECENT_WINDOW_MS,
  );
  return {
    activity,
    isNew,
    isRecentlyUpdated,
    label: hasBeenUpdated ? "更新" : "初回観測",
  };
}

export function priceDropped(
  product: DisplayProduct,
): product is DisplayProduct & { price_yen: number; previous_price_yen: number } {
  return (
    product.previous_price_yen != null &&
    product.price_yen != null &&
    product.price_yen < product.previous_price_yen
  );
}

/** Haystack for client-side favorite search; mirrors the columns the server FTS projection uses. */
export function normalizedSearchText(product: DisplayProduct): string {
  return [
    product.title,
    product.model,
    product.manufacturer,
    product.raw_manufacturer,
    product.category,
    product.raw_category,
    product.search_aliases,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ja-JP");
}

/** Sort key used when ordering favorites by recency. */
export function activityTime(product: DisplayProduct): number {
  return (
    safeDate(
      product.last_activity_at || product.first_seen_at || product.last_seen_at,
    )?.getTime() || 0
  );
}
