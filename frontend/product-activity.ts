/**
 * Freshness and price-drop derivation for a product result.
 *
 * `now` is a parameter rather than an implicit `Date.now()` so the 48-hour boundaries can be
 * tested exactly instead of approximately.
 *
 * Every input here is an aggregate over the product's offers, which is why "new" means *some*
 * offer is new rather than the product being new: a model that has been on sale for years becomes
 * newsworthy again the moment another shop lists one.
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
 * A product is NEW while one of its offers was listed in the last 48 hours, and UPDATED when a
 * later change happened instead — never both, so a freshly listed product that changes price
 * immediately still reads as new rather than flipping badge.
 */
export function activityData(product: DisplayProduct, now = Date.now()): ActivityData {
  const listed = safeDate(product.newest_listed_at);
  const activity = safeDate(product.latest_activity_at) || listed;
  const isNew = Boolean(listed && now - listed.getTime() < RECENT_WINDOW_MS);
  const hasBeenUpdated = Boolean(activity && listed && activity.getTime() > listed.getTime());
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

export function priceDropped(product: DisplayProduct): boolean {
  return product.has_price_drop;
}

/** Haystack for client-side favorite search; mirrors the terms the server entity index holds. */
export function normalizedSearchText(product: DisplayProduct): string {
  return [
    product.manufacturer,
    product.manufacturer_id,
    product.model,
    product.category,
    product.representative_offer?.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ja-JP");
}

/** Sort key used when ordering favorites by recency. */
export function activityTime(product: DisplayProduct): number {
  return safeDate(product.latest_activity_at || product.newest_listed_at)?.getTime() || 0;
}
