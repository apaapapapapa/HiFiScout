/**
 * Which cron dispatches which shop.
 *
 * Shops with exceptional cadences declare `scheduleCron` on their definition. Every other shop
 * belongs to one deterministic round-robin sequence: one shop is selected for each ten-minute
 * rotation tick. The slot is derived from the scheduled event timestamp rather than wall-clock
 * execution time, so delayed Cron delivery cannot reorder the rotation.
 */

import { SHOP_PLUGINS } from "./shops/index.js";
import type { ShopPlugin } from "./types.js";

const ROUND_ROBIN_SLOT_MS = 10 * 60_000;

/** Shops that own a cron trigger. */
export function shopsWithDedicatedCron(): ShopPlugin[] {
  return SHOP_PLUGINS.filter((plugin) => Boolean(plugin.definition.scheduleCron));
}

/** Shops sharing the ten-minute round-robin trigger, in stable registry order. */
export function shopsInRoundRobin(): ShopPlugin[] {
  return SHOP_PLUGINS.filter((plugin) => !plugin.definition.scheduleCron);
}

/** The shop a cron expression dispatches, or `null` for shared/non-crawl crons. */
export function shopForCron(cron: string): ShopPlugin | null {
  if (!cron) return null;
  return SHOP_PLUGINS.find((plugin) => plugin.definition.scheduleCron === cron) || null;
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
