/**
 * Which cron dispatches which shop.
 *
 * A shop that needs its own cadence declares `scheduleCron` on its definition rather than being
 * named in the Worker's scheduled handler. Two rules follow from that, and both live here so a
 * new shop cannot get them half-right:
 *
 * 1. a dedicated cron dispatches exactly its own shop;
 * 2. the shared "due shops" sweep skips every shop that has a dedicated cron, so a shop is never
 *    dispatched twice in the same window.
 */

import { SHOP_PLUGINS } from "./shops/index.js";
import type { ShopPlugin } from "./types.js";

/** Shops that own a cron trigger. */
export function shopsWithDedicatedCron(): ShopPlugin[] {
  return SHOP_PLUGINS.filter((plugin) => Boolean(plugin.definition.scheduleCron));
}

/** The shop a cron expression dispatches, or `null` for the shared sweep and non-crawl crons. */
export function shopForCron(cron: string): ShopPlugin | null {
  if (!cron) return null;
  return SHOP_PLUGINS.find((plugin) => plugin.definition.scheduleCron === cron) || null;
}

/** Shop keys the shared sweep must skip. */
export function sharedSweepExclusions(): string[] {
  return shopsWithDedicatedCron().map((plugin) => plugin.key);
}
