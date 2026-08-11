export const SHOP_DEFINITIONS = {
  audiounion: {
    key: 'audiounion',
    name: 'Audio Union',
    baseUrl: 'https://www.audiounion.jp',
    intervalEnv: 'AUDIOUNION_INTERVAL_MINUTES',
    defaultIntervalMinutes: 30
  },
  ippinkan: {
    key: 'ippinkan',
    name: '逸品館',
    baseUrl: 'https://ippinkan.jp',
    intervalEnv: 'IPPINKAN_INTERVAL_MINUTES',
    defaultIntervalMinutes: 30
  },
  hifido: {
    key: 'hifido',
    name: 'ハイファイ堂',
    baseUrl: 'https://www.hifido.co.jp',
    intervalEnv: 'HIFIDO_INTERVAL_MINUTES',
    defaultIntervalMinutes: 30,
    maxPagesEnv: 'HIFIDO_MAX_PAGES',
    defaultMaxPages: 3
  },
  formusic: {
    key: 'formusic',
    name: 'FOR MUSIC',
    baseUrl: 'https://shop.formusic.jp',
    intervalEnv: 'FORMUSIC_INTERVAL_MINUTES',
    defaultIntervalMinutes: 30
  },
  fujiyaAvic: {
    key: 'fujiya-avic',
    name: 'フジヤエービック',
    baseUrl: 'https://www.fujiya-avic.co.jp',
    intervalEnv: 'FUJIYA_AVIC_INTERVAL_MINUTES',
    defaultIntervalMinutes: 30,
    maxPagesEnv: 'FUJIYA_AVIC_MAX_PAGES',
    defaultMaxPages: 50
  }
};

export function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getShopIntervalMinutes(env, shop) {
  return positiveInt(env?.[shop.intervalEnv], shop.defaultIntervalMinutes);
}

export function getShopMaxPages(env, shop, fallback) {
  if (!shop) return fallback;
  return positiveInt(env?.[shop.maxPagesEnv], shop.defaultMaxPages || fallback);
}

export function getCrawlerSettings(env) {
  return {
    requestDelayMs: positiveInt(env?.CRAWL_REQUEST_DELAY_MS, 1200),
    maxPagesPerShop: positiveInt(env?.CRAWL_MAX_PAGES_PER_SHOP, 20),
    userAgent: env?.CRAWLER_USER_AGENT || 'HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)'
  };
}
