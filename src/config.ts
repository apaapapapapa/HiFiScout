import type {
  CrawlerEnv,
  CrawlerSettings,
  InventoryRecheckSettings,
  MaintenanceSettings,
  ShopDefinition,
  ShopEnvSuffix,
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

/**
 * The whole shop configuration surface, as a record so that adding a {@link ShopEnvSuffix}
 * without teaching this module to read it is a compile error.
 */
const SHOP_ENV_SUFFIX_SET: Readonly<Record<ShopEnvSuffix, true>> = {
  ENABLED: true,
  INTERVAL_MINUTES: true,
  REQUEST_DELAY_MS: true,
  MAX_PAGES: true,
  INVENTORY_RECHECK_ENABLED: true,
  INVENTORY_RECHECK_MIN_AGE_HOURS: true,
  INVENTORY_RECHECK_INTERVAL_HOURS: true,
  INVENTORY_RECHECK_FAILURE_THRESHOLD: true,
};

/** Every setting suffix a registered shop can be configured with. */
export const SHOP_ENV_SUFFIXES = Object.keys(SHOP_ENV_SUFFIX_SET) as readonly ShopEnvSuffix[];

/** The variable a shop setting is read from: its env prefix joined to the setting suffix. */
export function shopEnvVarName(shop: ShopDefinition, suffix: ShopEnvSuffix): string {
  return `${shop.envPrefix}_${suffix}`;
}

/**
 * Reads one shop-scoped variable.
 *
 * Shop variable names are composed at runtime from the definition's env prefix, so they are not
 * members of `CrawlerEnv`'s finite key set and cannot be indexed through it. This function is
 * the only place that widens the environment, and it is what keeps registering a shop from
 * meaning an edit to the crawler's environment vocabulary. Both halves of the name are
 * constrained elsewhere: the prefix is validated at registration, the suffix by
 * {@link ShopEnvSuffix}.
 */
function shopEnvValue(
  env: CrawlerEnv | undefined,
  shop: ShopDefinition,
  suffix: ShopEnvSuffix,
): unknown {
  return (env as unknown as Record<string, unknown> | undefined)?.[shopEnvVarName(shop, suffix)];
}

export function getShopEnabled(env: CrawlerEnv | undefined, shop: ShopDefinition): boolean {
  return booleanFlag(shopEnvValue(env, shop, "ENABLED"), shop.defaultEnabled !== false);
}

export function getShopIntervalMinutes(env: CrawlerEnv | undefined, shop: ShopDefinition): number {
  return positiveInt(shopEnvValue(env, shop, "INTERVAL_MINUTES"), shop.defaultIntervalMinutes);
}

export function getShopMaxPages(
  env: CrawlerEnv | undefined,
  shop: ShopDefinition | undefined,
  fallback: number,
): number {
  if (!shop) return fallback;
  return positiveInt(shopEnvValue(env, shop, "MAX_PAGES"), shop.defaultMaxPages || fallback);
}

export function getShopRequestDelayMs(
  env: CrawlerEnv | undefined,
  shop: ShopDefinition | undefined,
  fallback: number,
): number {
  if (!shop) return fallback;
  const defaultDelay = shop.defaultRequestDelayMs ?? fallback;
  return nonNegativeInt(shopEnvValue(env, shop, "REQUEST_DELAY_MS"), defaultDelay);
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
    // These three nest: collection gives up first, derived work defers next on its own budget in
    // `src/crawler/crawl-continuation.ts`, and the invocation bound sits above both so an ordinary
    // deferral never becomes a failure. The whole set, plus the terminal phases that follow it, has
    // to fit inside Cloudflare's fifteen-minute Queue limit — `test/crawl-deadline.test.ts` is what
    // keeps that ordering true when one of them is retuned.
    collectionBudgetMs: positiveInt(env?.CRAWL_COLLECTION_BUDGET_MS, 240_000),
    invocationBudgetMs: positiveInt(env?.CRAWL_INVOCATION_BUDGET_MS, 600_000),
    terminalBudgetMs: positiveInt(env?.CRAWL_TERMINAL_BUDGET_MS, 15_000),
    userAgent:
      env?.CRAWLER_USER_AGENT || "HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)",
  };
}

/**
 * Inventory recheck is opt-in per shop and defaults to off, so enabling it is always a
 * deliberate act. The failure threshold has a hard floor of 2: one unavailable observation must
 * never be enough to deactivate a listing.
 */
export function getShopInventoryRecheckSettings(
  env: CrawlerEnv | undefined,
  shop: ShopDefinition,
): InventoryRecheckSettings {
  return {
    enabled: booleanFlag(shopEnvValue(env, shop, "INVENTORY_RECHECK_ENABLED"), false),
    minListingAgeHours: positiveInt(shopEnvValue(env, shop, "INVENTORY_RECHECK_MIN_AGE_HOURS"), 24),
    intervalHours: positiveInt(shopEnvValue(env, shop, "INVENTORY_RECHECK_INTERVAL_HOURS"), 24),
    failureThreshold: Math.max(
      2,
      positiveInt(shopEnvValue(env, shop, "INVENTORY_RECHECK_FAILURE_THRESHOLD"), 2),
    ),
  };
}

/**
 * Retention horizons, and the two the remediation queue needs of its own.
 *
 * Every other table here is a log: rows arrive at roughly the rate the system does work, so a long
 * horizon and a modest batch keep up. The remediation queue is not. A resolver version bump seeds
 * one job per active listing, the resolved rows are never reused (the archive trigger rewrites the
 * work key so the same listing can be seeded again), and the table had reached 78k rows — all of
 * them settled — before anything was eligible to be deleted at all. Sharing the 180-day
 * data-quality horizon meant the first delete would not run until the table held over a million
 * rows, and a 500-row daily batch could not have drained it afterwards either.
 *
 * So this queue gets a horizon measured in days and a batch that clears more than a day of accrual
 * in one pass. Settled jobs are operational history; the durable state they produced lives in
 * `products` and the projection tables.
 */
export function getMaintenanceSettings(env: CrawlerEnv | undefined): MaintenanceSettings {
  return {
    crawlRunRetentionDays: positiveInt(env?.CRAWL_RUN_RETENTION_DAYS, 30),
    dataQualityRetentionDays: positiveInt(env?.DATA_QUALITY_RETENTION_DAYS, 180),
    remediationQueueRetentionDays: positiveInt(env?.REMEDIATION_QUEUE_RETENTION_DAYS, 7),
    priceHistoryRetentionDays: positiveInt(env?.PRICE_HISTORY_RETENTION_DAYS, 1095),
    inactiveProductRetentionDays: positiveInt(env?.INACTIVE_PRODUCT_RETENTION_DAYS, 365),
    deleteBatchSize: Math.min(1000, positiveInt(env?.RETENTION_DELETE_BATCH_SIZE, 500)),
    remediationQueueDeleteLimit: Math.min(
      100_000,
      positiveInt(env?.REMEDIATION_QUEUE_DELETE_LIMIT, 40_000),
    ),
  };
}
