import type {
  CrawlerEnv,
  CrawlerSettings,
  InventoryRecheckSettings,
  MaintenanceSettings,
  ShopDefinition,
} from "./crawler/types.js";
import { SHOP_PLUGINS } from "./crawler/shops/index.js";

export const SHOP_DEFINITIONS: Record<string, ShopDefinition> = Object.fromEntries(
  SHOP_PLUGINS.map((plugin): [string, ShopDefinition] => [plugin.key, plugin.definition]),
);

export function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function nonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function ratio(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}

export function booleanFlag(value: unknown, fallback = true): boolean {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function getShopEnabled(env: CrawlerEnv | undefined, shop: ShopDefinition): boolean {
  return booleanFlag(env?.[shop.enabledEnv], true);
}

export function getShopIntervalMinutes(env: CrawlerEnv | undefined, shop: ShopDefinition): number {
  return positiveInt(env?.[shop.intervalEnv], shop.defaultIntervalMinutes);
}

export function getShopMaxPages(
  env: CrawlerEnv | undefined,
  shop: ShopDefinition | undefined,
  fallback: number,
): number {
  if (!shop) return fallback;
  // `shop.maxPagesEnv` is optional; guarding it is equivalent to the previous
  // `env?.[undefined]` lookup, which always produced `undefined`.
  const configured = shop.maxPagesEnv ? env?.[shop.maxPagesEnv] : undefined;
  return positiveInt(configured, shop.defaultMaxPages || fallback);
}

export function getShopRequestDelayMs(
  env: CrawlerEnv | undefined,
  shop: ShopDefinition | undefined,
  fallback: number,
): number {
  if (!shop) return fallback;
  const defaultDelay = shop.defaultRequestDelayMs ?? fallback;
  return nonNegativeInt(env?.[shop.requestDelayEnv], defaultDelay);
}

export function getCrawlerSettings(env: CrawlerEnv | undefined): CrawlerSettings {
  return {
    requestDelayMs: nonNegativeInt(env?.CRAWL_REQUEST_DELAY_MS, 1200),
    maxPagesPerShop: positiveInt(env?.CRAWL_MAX_PAGES_PER_SHOP, 20),
    minItemRatio: ratio(env?.CRAWL_MIN_ITEM_RATIO, 0.5),
    minItemBaseline: positiveInt(env?.CRAWL_MIN_ITEM_BASELINE, 20),
    healthWarningFactor: positiveNumber(env?.SYNC_HEALTH_WARNING_FACTOR, 2),
    healthCriticalFactor: positiveNumber(env?.SYNC_HEALTH_CRITICAL_FACTOR, 6),
    dispatchLeaseMinutes: positiveInt(env?.CRAWL_DISPATCH_LEASE_MINUTES, 15),
    productTouchIntervalMinutes: positiveInt(env?.PRODUCT_TOUCH_INTERVAL_MINUTES, 1440),
    userAgent:
      env?.CRAWLER_USER_AGENT || "HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)",
  };
}

export function getAudioUnionInventoryRecheckSettings(
  env: CrawlerEnv | undefined,
): InventoryRecheckSettings {
  return {
    enabled: booleanFlag(env?.AUDIOUNION_INVENTORY_RECHECK_ENABLED, false),
    minListingAgeHours: positiveInt(env?.AUDIOUNION_INVENTORY_RECHECK_MIN_AGE_HOURS, 24),
    intervalHours: positiveInt(env?.AUDIOUNION_INVENTORY_RECHECK_INTERVAL_HOURS, 24),
    failureThreshold: Math.max(
      2,
      positiveInt(env?.AUDIOUNION_INVENTORY_RECHECK_FAILURE_THRESHOLD, 2),
    ),
  };
}

export function getMaintenanceSettings(env: CrawlerEnv | undefined): MaintenanceSettings {
  return {
    crawlRunRetentionDays: positiveInt(env?.CRAWL_RUN_RETENTION_DAYS, 30),
    dataQualityRetentionDays: positiveInt(env?.DATA_QUALITY_RETENTION_DAYS, 180),
    priceHistoryRetentionDays: positiveInt(env?.PRICE_HISTORY_RETENTION_DAYS, 1095),
    inactiveProductRetentionDays: positiveInt(env?.INACTIVE_PRODUCT_RETENTION_DAYS, 365),
    deleteBatchSize: Math.min(1000, positiveInt(env?.RETENTION_DELETE_BATCH_SIZE, 500)),
  };
}
