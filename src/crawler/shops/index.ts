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
import { ippinkanAdapter } from "./ippinkan.js";
import { fujiyaAvicAdapter } from "./fujiya-avic.js";
import { hifidoAdapter } from "./hifido.js";
import { forMusicAdapter } from "./formusic.js";
import { uAudioAdapter } from "./u-audio.js";
import { shimamusenAdapter } from "./shimamusen.js";
// shop-generator:imports

export { getShopActivityPolicy } from "./registry.js";

/** Hifido re-lists the same stock with edited titles, so only price and stock are user activity. */
const HIFIDO_ACTIVITY_POLICY: Readonly<ProductActivityPolicy> = Object.freeze({
  ...DEFAULT_PRODUCT_ACTIVITY_POLICY,
  model: false,
  title: false,
  condition: false,
});

export const SHOP_PLUGINS: readonly ShopPlugin[] = createShopRegistry([
  defineShopPlugin(
    audioUnionAdapter,
    {
      key: "audiounion",
      name: "Audio Union",
      baseUrl: "https://www.audiounion.jp",
      defaultIntervalMinutes: 30,
      defaultRequestDelayMs: 10_000,
      scheduleCron: "1 * * * *",
      transportConfigurationRequired: true,
    },
    { diagnostics: { diagnosePage: diagnoseAudioUnionHtml } },
  ),
  defineShopPlugin(ippinkanAdapter, {
    key: "ippinkan",
    name: "逸品館",
    baseUrl: "https://ippinkan.jp",
    defaultIntervalMinutes: 30,
  }),
  defineShopPlugin(fujiyaAvicAdapter, {
    key: "fujiya-avic",
    name: "フジヤエービック",
    baseUrl: "https://www.fujiya-avic.co.jp",
    defaultIntervalMinutes: 30,
    defaultMaxPages: 50,
    scheduleCron: "30 * * * *",
  }),
  defineShopPlugin(
    hifidoAdapter,
    {
      key: "hifido",
      name: "ハイファイ堂",
      baseUrl: "https://www.hifido.co.jp",
      defaultIntervalMinutes: 30,
      defaultMaxPages: 3,
    },
    { activityPolicy: HIFIDO_ACTIVITY_POLICY },
  ),
  defineShopPlugin(forMusicAdapter, {
    key: "formusic",
    name: "FOR MUSIC",
    baseUrl: "https://shop.formusic.jp",
    defaultIntervalMinutes: 30,
  }),
  defineShopPlugin(uAudioAdapter, {
    key: "u-audio",
    name: "U-AUDIO",
    baseUrl: "https://www.u-audio.com",
    // Its deployed variables predate the derived spelling; `U_AUDIO_*` would silently reset the
    // shop to its defaults.
    envPrefix: "UAUDIO",
    defaultIntervalMinutes: 60,
    defaultMaxPages: 50,
  }),
  defineShopPlugin(shimamusenAdapter, {
    key: "shimamusen",
    name: "シマムセン",
    baseUrl: "https://www.shimamusen.com",
    defaultIntervalMinutes: 60,
    defaultMaxPages: 20,
  }),
  // shop-generator:plugins
]);

export function getShopPlugin(shopKey: string | null | undefined): ShopPlugin | null {
  return SHOP_PLUGINS.find((plugin) => plugin.key === shopKey) || null;
}
