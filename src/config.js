import { SHOP_PLUGINS } from './crawler/shops/index.js';

export const SHOP_DEFINITIONS = Object.fromEntries(
  SHOP_PLUGINS.map(plugin => [plugin.key, plugin.definition])
);

export function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function positiveNumber(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function ratio(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}

export function booleanFlag(value, fallback = true) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function getShopEnabled(env, shop) {
  return booleanFlag(env?.[shop.enabledEnv], true);
}

export function getShopIntervalMinutes(env, shop) {
  return positiveInt(env?.[shop.intervalEnv], shop.defaultIntervalMinutes);
}

export function getShopMaxPages(env, shop, fallback) {
  if (!shop) return fallback;
  return positiveInt(env?.[shop.maxPagesEnv], shop.defaultMaxPages || fallback);
}

export function getShopRequestDelayMs(env, shop, fallback) {
  if (!shop) return fallback;
  const defaultDelay = shop.defaultRequestDelayMs ?? fallback;
  return nonNegativeInt(env?.[shop.requestDelayEnv], defaultDelay);
}

export function getCrawlerSettings(env) {
  return {
    requestDelayMs: nonNegativeInt(env?.CRAWL_REQUEST_DELAY_MS, 1200),
    maxPagesPerShop: positiveInt(env?.CRAWL_MAX_PAGES_PER_SHOP, 20),
    minItemRatio: ratio(env?.CRAWL_MIN_ITEM_RATIO, 0.5),
    minItemBaseline: positiveInt(env?.CRAWL_MIN_ITEM_BASELINE, 20),
    healthWarningFactor: positiveNumber(env?.SYNC_HEALTH_WARNING_FACTOR, 2),
    healthCriticalFactor: positiveNumber(env?.SYNC_HEALTH_CRITICAL_FACTOR, 6),
    dispatchLeaseMinutes: positiveInt(env?.CRAWL_DISPATCH_LEASE_MINUTES, 15),
    productTouchIntervalMinutes: positiveInt(env?.PRODUCT_TOUCH_INTERVAL_MINUTES, 1440),
    userAgent: env?.CRAWLER_USER_AGENT || 'HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)'
  };
}

export function getMaintenanceSettings(env) {
  return {
    crawlRunRetentionDays: positiveInt(env?.CRAWL_RUN_RETENTION_DAYS, 30),
    priceHistoryRetentionDays: positiveInt(env?.PRICE_HISTORY_RETENTION_DAYS, 1095),
    inactiveProductRetentionDays: positiveInt(env?.INACTIVE_PRODUCT_RETENTION_DAYS, 365),
    deleteBatchSize: Math.min(1000, positiveInt(env?.RETENTION_DELETE_BATCH_SIZE, 500))
  };
}
