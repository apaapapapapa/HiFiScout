import type { CrawlPage, ShopAdapter, ShopDefinition, ShopPlugin } from "../types.js";
import { normalizeCatalogProducts } from "../../catalog/product-normalizer.js";
import { audioUnionAdapter } from "./audiounion.js";
import { ippinkanAdapter } from "./ippinkan.js";
import { fujiyaAvicAdapter } from "./fujiya-avic.js";
import { hifidoAdapter } from "./hifido.js";
import { forMusicAdapter } from "./formusic.js";
import { uAudioAdapter } from "./u-audio.js";
import { shimamusenAdapter } from "./shimamusen.js";
// shop-generator:imports

function defineShopPlugin(adapter: ShopAdapter, definition: ShopDefinition): ShopPlugin {
  if (!adapter?.key || adapter.key !== definition.key) {
    throw new Error(`shop plugin key mismatch: ${adapter?.key || "missing"} / ${definition.key}`);
  }

  const parse = adapter.parse;
  // `parse` is supplied in the literal (rather than assigned afterwards) so the plugin can be
  // typed without an assertion. Runtime is unchanged: the spread already places `parse` at the
  // adapter's key position, the explicit entry only replaces its value, and `plugin` is only
  // dereferenced when the wrapper is later called.
  const plugin: ShopPlugin = {
    ...adapter,
    definition: Object.freeze({ ...definition }),
    parse: function normalizedParse(...args: [html: string, page?: CrawlPage]) {
      return normalizeCatalogProducts(parse.apply(plugin, args), plugin);
    },
  };

  return Object.freeze(plugin);
}

export const SHOP_PLUGINS: ShopPlugin[] = [
  defineShopPlugin(audioUnionAdapter, {
    key: "audiounion",
    name: "Audio Union",
    baseUrl: "https://www.audiounion.jp",
    intervalEnv: "AUDIOUNION_INTERVAL_MINUTES",
    enabledEnv: "AUDIOUNION_ENABLED",
    requestDelayEnv: "AUDIOUNION_REQUEST_DELAY_MS",
    defaultIntervalMinutes: 30,
    defaultRequestDelayMs: 10_000,
    scheduleCron: "1 * * * *",
    transportConfigurationRequired: true,
  }),
  defineShopPlugin(ippinkanAdapter, {
    key: "ippinkan",
    name: "逸品館",
    baseUrl: "https://ippinkan.jp",
    intervalEnv: "IPPINKAN_INTERVAL_MINUTES",
    enabledEnv: "IPPINKAN_ENABLED",
    requestDelayEnv: "IPPINKAN_REQUEST_DELAY_MS",
    defaultIntervalMinutes: 30,
  }),
  defineShopPlugin(fujiyaAvicAdapter, {
    key: "fujiya-avic",
    name: "フジヤエービック",
    baseUrl: "https://www.fujiya-avic.co.jp",
    intervalEnv: "FUJIYA_AVIC_INTERVAL_MINUTES",
    enabledEnv: "FUJIYA_AVIC_ENABLED",
    requestDelayEnv: "FUJIYA_AVIC_REQUEST_DELAY_MS",
    defaultIntervalMinutes: 30,
    maxPagesEnv: "FUJIYA_AVIC_MAX_PAGES",
    defaultMaxPages: 50,
    scheduleCron: "30 * * * *",
  }),
  defineShopPlugin(hifidoAdapter, {
    key: "hifido",
    name: "ハイファイ堂",
    baseUrl: "https://www.hifido.co.jp",
    intervalEnv: "HIFIDO_INTERVAL_MINUTES",
    enabledEnv: "HIFIDO_ENABLED",
    requestDelayEnv: "HIFIDO_REQUEST_DELAY_MS",
    defaultIntervalMinutes: 30,
    maxPagesEnv: "HIFIDO_MAX_PAGES",
    defaultMaxPages: 3,
  }),
  defineShopPlugin(forMusicAdapter, {
    key: "formusic",
    name: "FOR MUSIC",
    baseUrl: "https://shop.formusic.jp",
    intervalEnv: "FORMUSIC_INTERVAL_MINUTES",
    enabledEnv: "FORMUSIC_ENABLED",
    requestDelayEnv: "FORMUSIC_REQUEST_DELAY_MS",
    defaultIntervalMinutes: 30,
  }),
  defineShopPlugin(uAudioAdapter, {
    key: "u-audio",
    name: "U-AUDIO",
    baseUrl: "https://www.u-audio.com",
    intervalEnv: "UAUDIO_INTERVAL_MINUTES",
    enabledEnv: "UAUDIO_ENABLED",
    requestDelayEnv: "UAUDIO_REQUEST_DELAY_MS",
    defaultIntervalMinutes: 60,
    maxPagesEnv: "UAUDIO_MAX_PAGES",
    defaultMaxPages: 50,
  }),
  defineShopPlugin(shimamusenAdapter, {
    key: "shimamusen",
    name: "シマムセン",
    baseUrl: "https://www.shimamusen.com",
    intervalEnv: "SHIMAMUSEN_INTERVAL_MINUTES",
    enabledEnv: "SHIMAMUSEN_ENABLED",
    requestDelayEnv: "SHIMAMUSEN_REQUEST_DELAY_MS",
    defaultIntervalMinutes: 60,
    maxPagesEnv: "SHIMAMUSEN_MAX_PAGES",
    defaultMaxPages: 20,
  }),
  // shop-generator:plugins
];

// Compatibility alias for existing callers. New code should treat each entry as a shop plugin.
export const SHOP_ADAPTERS: ShopPlugin[] = SHOP_PLUGINS;

export function getShopPlugin(shopKey: string | null | undefined): ShopPlugin | null {
  return SHOP_PLUGINS.find((plugin) => plugin.key === shopKey) || null;
}
