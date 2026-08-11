export const SHOP_DEFINITIONS = {
  audiounion: {
    key: 'audiounion',
    name: 'Audio Union',
    baseUrl: 'https://www.audiounion.jp',
    intervalEnv: 'AUDIOUNION_INTERVAL_MINUTES',
    enabledEnv: 'AUDIOUNION_ENABLED',
    requestDelayEnv: 'AUDIOUNION_REQUEST_DELAY_MS',
    defaultIntervalMinutes: 30,
    defaultRequestDelayMs: 10_000
  },
  ippinkan: {
    key: 'ippinkan',
    name: '逸品館',
    baseUrl: 'https://ippinkan.jp',
    intervalEnv: 'IPPINKAN_INTERVAL_MINUTES',
    enabledEnv: 'IPPINKAN_ENABLED',
    requestDelayEnv: 'IPPINKAN_REQUEST_DELAY_MS',
    defaultIntervalMinutes: 30
  },
  hifido: {
    key: 'hifido',
    name: 'ハイファイ堂',
    baseUrl: 'https://www.hifido.co.jp',
    intervalEnv: 'HIFIDO_INTERVAL_MINUTES',
    enabledEnv: 'HIFIDO_ENABLED',
    requestDelayEnv: 'HIFIDO_REQUEST_DELAY_MS',
    defaultIntervalMinutes: 30,
    maxPagesEnv: 'HIFIDO_MAX_PAGES',
    defaultMaxPages: 3
  },
  formusic: {
    key: 'formusic',
    name: 'FOR MUSIC',
    baseUrl: 'https://shop.formusic.jp',
    intervalEnv: 'FORMUSIC_INTERVAL_MINUTES',
    enabledEnv: 'FORMUSIC_ENABLED',
    requestDelayEnv: 'FORMUSIC_REQUEST_DELAY_MS',
    defaultIntervalMinutes: 30
  },
  fujiyaAvic: {
    key: 'fujiya-avic',
    name: 'フジヤエービック',
    baseUrl: 'https://www.fujiya-avic.co.jp',
    intervalEnv: 'FUJIYA_AVIC_INTERVAL_MINUTES',
    enabledEnv: 'FUJIYA_AVIC_ENABLED',
    requestDelayEnv: 'FUJIYA_AVIC_REQUEST_DELAY_MS',
    defaultIntervalMinutes: 30,
    maxPagesEnv: 'FUJIYA_AVIC_MAX_PAGES',
    defaultMaxPages: 50
  }
};

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
    userAgent: env?.CRAWLER_USER_AGENT || 'HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)'
  };
}
