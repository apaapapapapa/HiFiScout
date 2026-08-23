/**
 * Which cron dispatches which shop.
 *
 * Shops with a dedicated cadence declare `scheduleCron` on their definition. Every other shop
 * participates in one deterministic 15-minute round-robin. The round-robin trigger is offset from
 * the dedicated minute marks so normal crawl dispatches never start at the same time.
 */

import { SHOP_PLUGINS } from "./shops/index.js";
import type { ShopPlugin } from "./types.js";

/** Every 15 minutes, offset to avoid :01/:31 dedicated jobs and the daily :30 job. */
export const ROUND_ROBIN_CRAWL_CRON = "7,22,37,52 * * * *";
export const ROUND_ROBIN_INTERVAL_MINUTES = 15;

const ROUND_ROBIN_SLOT_MS = ROUND_ROBIN_INTERVAL_MINUTES * 60_000;
const ROUND_ROBIN_ANCHOR_MS = Date.UTC(1970, 0, 1, 0, 7, 0, 0);

/** Shops that own their own cron trigger. */
export function shopsWithDedicatedCron(): ShopPlugin[] {
  return SHOP_PLUGINS.filter((plugin) => Boolean(plugin.definition.scheduleCron));
}

/** Shops that share the 15-minute round-robin trigger. Registry order is the rotation order. */
export function roundRobinShops(): ShopPlugin[] {
  return SHOP_PLUGINS.filter((plugin) => !plugin.definition.scheduleCron);
}

/** The shop a dedicated cron expression dispatches, or `null` when it is not shop-owned. */
export function shopForCron(cron: string): ShopPlugin | null {
  if (!cron) return null;
  return SHOP_PLUGINS.find((plugin) => plugin.definition.scheduleCron === cron) || null;
}

/**
 * Selects exactly one non-dedicated shop for a scheduled round-robin invocation.
 *
 * Selection is derived from the scheduled timestamp rather than mutable state. A retried Cron
 * event therefore resolves to the same shop, while the next 15-minute slot advances exactly once.
 */
export function shopForRoundRobinSlot(scheduledTimeMs: number): ShopPlugin | null {
  const shops = roundRobinShops();
  if (!shops.length || !Number.isFinite(scheduledTimeMs)) return null;
  const slot = Math.floor((scheduledTimeMs - ROUND_ROBIN_ANCHOR_MS) / ROUND_ROBIN_SLOT_MS);
  const index = ((slot % shops.length) + shops.length) % shops.length;
  return shops[index] || null;
}
