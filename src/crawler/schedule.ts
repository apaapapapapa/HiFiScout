/**
 * Which cron dispatches which shop.
 *
 * Shops with exceptional cadences declare `scheduleCron` on their definition. Multiple shops may
 * share one dedicated trigger; in that case the scheduled event timestamp selects exactly one shop
 * from the stable registry order. Every other shop gets two daily slots, ten minutes apart from
 * 11:00 and 17:00 JST, without wrapping after the last shop. All slot decisions use the scheduled event
 * timestamp rather than wall-clock execution time, so delayed Cron delivery cannot reorder them.
 */

import { SHOP_PLUGINS } from "./shops/index.js";
import { isCrawlQuietHours } from "./crawl-window.js";
import type { ShopPlugin } from "./types.js";

/** Must stay aligned with the ten-minute cadence declared by CRAWL_ROTATION_CRON. */
const DAILY_ROTATION_SLOT_MINUTES = 10;
/** Latest start first: 08:00/02:00 UTC are 17:00/11:00 JST. */
const DAILY_ROTATION_START_MINUTES_UTC = [8 * 60, 2 * 60] as const;
/** Shared dedicated trigger starts at :01 and advances to the next shop every 30 minutes. */
const SHARED_DEDICATED_SLOT_MS = 30 * 60_000;
/** :01 is the phase anchor, so every hour starts with the first registered shared shop. */
const SHARED_DEDICATED_ANCHOR_OFFSET_MS = 60_000;

/** Shops that own or share a dedicated cron trigger. */
export function shopsWithDedicatedCron(): ShopPlugin[] {
  return SHOP_PLUGINS.filter((plugin) => Boolean(plugin.definition.scheduleCron));
}

/** Shops with two daily slots on the shared trigger, in stable registry order. */
export function shopsInDailyRotation(): ShopPlugin[] {
  return SHOP_PLUGINS.filter((plugin) => !plugin.definition.scheduleCron);
}

/** All shops assigned to one dedicated cron expression, in stable registry order. */
export function shopsForCron(cron: string): ShopPlugin[] {
  if (!cron) return [];
  return SHOP_PLUGINS.filter((plugin) => plugin.definition.scheduleCron === cron);
}

/**
 * Select exactly one shop for a dedicated cron event.
 *
 * A cron owned by one shop simply returns that shop. When multiple shops share the same trigger,
 * the sequence is anchored at minute :01 and advances every 30 minutes, so two shops sharing an
 * hourly trigger take the :01 and :31 firings in registry order and each keeps an hourly cadence.
 */
export function shopForCronAtScheduledTime(cron: string, scheduledAt: Date): ShopPlugin | null {
  const shops = shopsForCron(cron);
  if (!shops.length) return null;
  if (shops.length === 1) return shops[0] || null;

  const scheduledMs = scheduledAt.getTime();
  if (!Number.isFinite(scheduledMs)) return null;

  const slot = Math.floor(
    (scheduledMs - SHARED_DEDICATED_ANCHOR_OFFSET_MS) / SHARED_DEDICATED_SLOT_MS,
  );
  const index = ((slot % shops.length) + shops.length) % shops.length;
  return shops[index] || null;
}

/** Shop keys excluded from the shared rotation because they own a dedicated cron. */
export function sharedSweepExclusions(): string[] {
  return shopsWithDedicatedCron().map((plugin) => plugin.key);
}

/**
 * Select a non-dedicated shop only during its ten-minute slot in either daily pass.
 *
 * Each pass starts at 11:00 or 17:00 JST and advances once through the registry. Remaining ticks
 * are idle until the next pass; a pass never wraps or borrows slots from the next one.
 * Disabled shops keep their slot so enabling/disabling one cannot move another shop's start.
 */
export function dailyRotationShopForScheduledTime(scheduledAt: Date): ShopPlugin | null {
  const shops = shopsInDailyRotation();
  const scheduledMs = scheduledAt.getTime();
  if (!Number.isFinite(scheduledMs) || isCrawlQuietHours(scheduledMs)) return null;

  const minutesSinceDayStart = scheduledAt.getUTCHours() * 60 + scheduledAt.getUTCMinutes();
  const startMinutes = DAILY_ROTATION_START_MINUTES_UTC.find(
    (start) => minutesSinceDayStart >= start,
  );
  if (startMinutes === undefined) return null;
  const slot = Math.floor((minutesSinceDayStart - startMinutes) / DAILY_ROTATION_SLOT_MINUTES);
  return shops[slot] || null;
}
