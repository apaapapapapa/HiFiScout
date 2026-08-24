/**
 * Which cron dispatches which shop.
 *
 * Shops with exceptional cadences declare `scheduleCron` on their definition. Multiple shops may
 * share one dedicated trigger; in that case the scheduled event timestamp selects exactly one shop
 * from the stable registry order. Every other shop belongs to one deterministic round-robin
 * sequence: one shop is selected for each ten-minute rotation tick. All slot decisions are derived
 * from the scheduled event timestamp rather than wall-clock execution time, so delayed Cron
 * delivery cannot reorder either sequence.
 */

import { SHOP_PLUGINS } from "./shops/index.js";
import type { ShopPlugin } from "./types.js";

/** Must stay aligned with the ten-minute cadence declared by CRAWL_ROTATION_CRON. */
const ROUND_ROBIN_SLOT_MS = 10 * 60_000;
/** Shared dedicated trigger starts at :01 and advances to the next shop every 30 minutes. */
const SHARED_DEDICATED_SLOT_MS = 30 * 60_000;
/** :01 is the phase anchor, so every hour starts with the first registered shared shop. */
const SHARED_DEDICATED_ANCHOR_OFFSET_MS = 60_000;

/** Shops that own or share a dedicated cron trigger. */
export function shopsWithDedicatedCron(): ShopPlugin[] {
  return SHOP_PLUGINS.filter((plugin) => Boolean(plugin.definition.scheduleCron));
}

/** Shops sharing the ten-minute round-robin trigger, in stable registry order. */
export function shopsInRoundRobin(): ShopPlugin[] {
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
 * Select exactly one non-dedicated shop for a ten-minute scheduled slot.
 *
 * Epoch-derived slots make the sequence deterministic across Worker instances and deployments;
 * advancing by ten minutes advances by exactly one shop and wraps after the full registry subset.
 */
export function roundRobinShopForScheduledTime(scheduledAt: Date): ShopPlugin | null {
  const shops = shopsInRoundRobin();
  const scheduledMs = scheduledAt.getTime();
  if (!shops.length || !Number.isFinite(scheduledMs)) return null;

  const slot = Math.floor(scheduledMs / ROUND_ROBIN_SLOT_MS);
  const index = ((slot % shops.length) + shops.length) % shops.length;
  return shops[index] || null;
}
