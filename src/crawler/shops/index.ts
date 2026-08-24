/**
 * The composition root for shops: the list of concrete adapters and the operational metadata
 * each one runs under. Nothing else in `src` may import a concrete shop module.
 *
 * Registration mechanics — validation, env-prefix derivation, catalog normalization, cross-shop
 * invariants — live in `registry.ts`, so this file stays a list a reviewer can read in one pass
 * and `create-shop` can extend mechanically.
 */

import type { ShopPlugin } from "../types.js";
import { createShopRegistry, defineShopPlugin } from "./registry.js";
import {
  DEFAULT_PRODUCT_ACTIVITY_POLICY,
  type ProductActivityPolicy,
} from "../../db/product-activity-policy.js";
import { audioUnionAdapter } from "./audiounion.js";
import { diagnoseAudioUnionHtml } from "./audiounion-diagnostics.js";
import { audioUnionInventoryRecheck } from "./audiounion-inventory.js";
import { ippinkanAdapter } from "./ippinkan.js";
import {
  FUJIYA_CATEGORY_POLICY,
  extractFujiyaDetailCategoryEvidence,
  fujiyaAvicAdapter,
} from "./fujiya-avic.js";
import {
  HIFIDO_CATEGORY_MAPPING,
  HIFIDO_CATEGORY_POLICY,
  extractHifidoDetailCategoryEvidence,
  hifidoAdapter,
} from "./hifido.js";
import {
  FORMUSIC_CATEGORY_MAPPING,
  FORMUSIC_CATEGORY_POLICY,
  forMusicAdapter,
} from "./formusic.js";
import { U_AUDIO_CATEGORY_MAPPING, U_AUDIO_CATEGORY_POLICY, uAudioAdapter } from "./u-audio.js";
import { SHIMAMUSEN_CATEGORY_POLICY, shimamusenAdapter } from "./shimamusen.js";
import { dynamicAudioAdapter } from "./dynamic-audio.js";
import { afroAudioAdapter } from "./afroaudio.js";
import { osakayaAdapter } from "./osakaya.js";
import { soundPitAdapter } from "./soundpit.js";
import {
  SOUND_SUPPORT_CATEGORY_MAPPING,
  SOUND_SUPPORT_CATEGORY_POLICY,
  soundSupportAdapter,
} from "./sound-support.js";
import { avacAdapter } from "./avac.js";
import { tereonAdapter } from "./tereon.js";
import {
  AUDIO_SPACE_CORE_CATEGORY_MAPPING,
  AUDIO_SPACE_CORE_CATEGORY_POLICY,
  audioSpaceCoreAdapter,
} from "./audio-space-core.js";
import { rewireAdapter } from "./rewire.js";
import {
  HOME_SHOKAI_CATEGORY_MAPPING,
  HOME_SHOKAI_CATEGORY_POLICY,
  homeShokaiAdapter,
} from "./home-shokai.js";
// shop-generator:imports

export { getShopActivityPolicy } from "./registry.js";

const ROUND_ROBIN_INTERVAL_MINUTES = 140;
const HOURLY_INTERVAL_MINUTES = 60;
const DAILY_INTERVAL_MINUTES = 24 * 60;

/** Hifido re-lists the same stock with edited titles, so only price and stock are user activity. */
const HIFIDO_ACTIVITY_POLICY: Readonly<ProductActivityPolicy> = Object.freeze({
  ...DEFAULT_PRODUCT_ACTIVITY_POLICY,
  model: false,
  title: false,
  condition: false,
});

// Osaka-ya's `av-amp` URL bucket is merchandising, not a reliable product type: it currently also
// contains the Marantz AMP 10 power amplifier. Keep it as corroboration so an explicit title/model
// can select the canonical leaf while genuine AV receiver titles still classify as `av_amp`.
const OSAKAYA_CATEGORY_POLICY = Object.freeze({
  sellerCategory: Object.freeze({
    default: "authoritative" as const,
    categories: Object.freeze({ av_amp: "corroborative" as const }),
  }),
  parserHint: "corroborative" as const,
});

export const SHOP_PLUGINS: readonly ShopPlugin[] = createShopRegistry([
  defineShopPlugin(
    audioUnionAdapter,
    {
      key: "audiounion",
      name: "Audio Union",
      baseUrl: "https://www.audiounion.jp",
      defaultIntervalMinutes: HOURLY_INTERVAL_MINUTES,
      defaultRequestDelayMs: 10_000,
      scheduleCron: "1 * * * *",
      transportConfigurationRequired: true,
    },
    {
      transport: { kind: "relay" },
      inventoryRecheck: audioUnionInventoryRecheck,
      diagnostics: { diagnosePage: diagnoseAudioUnionHtml },
    },
  ),
  defineShopPlugin(ippinkanAdapter, {
    key: "ippinkan",
    name: "逸品館",
    baseUrl: "https://ippinkan.jp",
    defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
  }),
  defineShopPlugin(
    fujiyaAvicAdapter,
    {
      key: "fujiya-avic",
      name: "フジヤエービック",
      baseUrl: "https://www.fujiya-avic.co.jp",
      defaultIntervalMinutes: DAILY_INTERVAL_MINUTES,
      defaultMaxPages: 50,
      // Cloudflare Cron uses UTC: 12:30 UTC = 21:30 JST.
      scheduleCron: "30 12 * * *",
    },
    {
      catalog: { categoryPolicy: FUJIYA_CATEGORY_POLICY },
      detailCategoryEvidence: { extract: extractFujiyaDetailCategoryEvidence },
    },
  ),
  defineShopPlugin(
    hifidoAdapter,
    {
      key: "hifido",
      name: "ハイファイ堂",
      baseUrl: "https://www.hifido.co.jp",
      defaultIntervalMinutes: HOURLY_INTERVAL_MINUTES,
      defaultMaxPages: 3,
      scheduleCron: "31 * * * *",
    },
    {
      transport: { kind: "relay" },
      catalog: {
        categoryMapping: HIFIDO_CATEGORY_MAPPING,
        categoryPolicy: HIFIDO_CATEGORY_POLICY,
      },
      detailCategoryEvidence: { extract: extractHifidoDetailCategoryEvidence },
      activityPolicy: HIFIDO_ACTIVITY_POLICY,
    },
  ),
  defineShopPlugin(
    forMusicAdapter,
    {
      key: "formusic",
      name: "FOR MUSIC",
      baseUrl: "https://shop.formusic.jp",
      defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
    },
    {
      catalog: {
        categoryMapping: FORMUSIC_CATEGORY_MAPPING,
        categoryPolicy: FORMUSIC_CATEGORY_POLICY,
      },
    },
  ),
  defineShopPlugin(
    uAudioAdapter,
    {
      key: "u-audio",
      name: "U-AUDIO",
      baseUrl: "https://www.u-audio.com",
      defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
      defaultMaxPages: 50,
    },
    {
      catalog: {
        categoryMapping: U_AUDIO_CATEGORY_MAPPING,
        categoryPolicy: U_AUDIO_CATEGORY_POLICY,
      },
    },
  ),
  defineShopPlugin(
    shimamusenAdapter,
    {
      key: "shimamusen",
      name: "シマムセン",
      baseUrl: "https://www.shimamusen.com",
      defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
      defaultMaxPages: 20,
    },
    { catalog: { categoryPolicy: SHIMAMUSEN_CATEGORY_POLICY } },
  ),
  defineShopPlugin(dynamicAudioAdapter, {
    key: "dynamic-audio",
    name: "DYNAMIC AUDIO",
    baseUrl: "https://dynamicaudio5used.wordpress.com",
    defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
    defaultMaxPages: 30,
  }),
  defineShopPlugin(afroAudioAdapter, {
    key: "afroaudio",
    name: "アフロオーディオ",
    baseUrl: "https://afroaudio.jp",
    defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
    defaultMaxPages: 50,
  }),
  defineShopPlugin(
    osakayaAdapter,
    {
      key: "osakaya",
      name: "CAVIN大阪屋",
      baseUrl: "https://osakaya.com",
      defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
      defaultMaxPages: 20,
    },
    { catalog: { categoryPolicy: OSAKAYA_CATEGORY_POLICY } },
  ),
  defineShopPlugin(soundPitAdapter, {
    key: "soundpit",
    name: "SOUND PIT",
    baseUrl: "https://sound-pit.jp",
    defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
    defaultMaxPages: 50,
  }),
  defineShopPlugin(
    soundSupportAdapter,
    {
      key: "sound-support",
      name: "Sound Support",
      baseUrl: "https://sound-support.jp",
      defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
      defaultMaxPages: 20,
    },
    {
      catalog: {
        categoryMapping: SOUND_SUPPORT_CATEGORY_MAPPING,
        categoryPolicy: SOUND_SUPPORT_CATEGORY_POLICY,
      },
    },
  ),
  defineShopPlugin(avacAdapter, {
    key: "avac",
    name: "アバック",
    baseUrl: "https://www.avac.co.jp",
    defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
    defaultMaxPages: 50,
  }),
  defineShopPlugin(tereonAdapter, {
    key: "tereon",
    name: "テレオン",
    baseUrl: "https://www.tereon-tsuhan.com",
    defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
    defaultRequestDelayMs: 1500,
    defaultMaxPages: 10,
  }),
  defineShopPlugin(
    audioSpaceCoreAdapter,
    {
      key: "audio-space-core",
      name: "オーディオスペースコア",
      baseUrl: "https://www.as-core.co.jp",
      defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
    },
    {
      catalog: {
        categoryMapping: AUDIO_SPACE_CORE_CATEGORY_MAPPING,
        categoryPolicy: AUDIO_SPACE_CORE_CATEGORY_POLICY,
      },
    },
  ),
  defineShopPlugin(rewireAdapter, {
    key: "rewire",
    name: "REWIRE",
    baseUrl: "https://rewire.co.jp",
    defaultEnabled: false,
    defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
    defaultRequestDelayMs: 1500,
    defaultMaxPages: 30,
  }),
  defineShopPlugin(
    homeShokaiAdapter,
    {
      key: "home-shokai",
      name: "ホーム商会",
      baseUrl: "https://www.homeshokai.jp",
      defaultIntervalMinutes: ROUND_ROBIN_INTERVAL_MINUTES,
      defaultRequestDelayMs: 1500,
      defaultMaxPages: 2,
    },
    {
      catalog: {
        categoryMapping: HOME_SHOKAI_CATEGORY_MAPPING,
        categoryPolicy: HOME_SHOKAI_CATEGORY_POLICY,
      },
    },
  ),
  // shop-generator:plugins
]);

export function getShopPlugin(shopKey: string | null | undefined): ShopPlugin | null {
  return SHOP_PLUGINS.find((plugin) => plugin.key === shopKey) || null;
}
