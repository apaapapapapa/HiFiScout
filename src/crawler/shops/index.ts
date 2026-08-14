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
import { HIFIDO_CATEGORY_MAPPING, hifidoAdapter } from "./hifido.js";
import { FORMUSIC_CATEGORY_MAPPING, forMusicAdapter } from "./formusic.js";
import { U_AUDIO_CATEGORY_MAPPING, U_AUDIO_CATEGORY_POLICY, uAudioAdapter } from "./u-audio.js";
import { SHIMAMUSEN_CATEGORY_POLICY, shimamusenAdapter } from "./shimamusen.js";
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
    defaultIntervalMinutes: 30,
  }),
  defineShopPlugin(
    fujiyaAvicAdapter,
    {
      key: "fujiya-avic",
      name: "フジヤエービック",
      baseUrl: "https://www.fujiya-avic.co.jp",
      defaultIntervalMinutes: 30,
      defaultMaxPages: 50,
      scheduleCron: "30 * * * *",
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
      defaultIntervalMinutes: 30,
      defaultMaxPages: 3,
    },
    {
      transport: { kind: "relay" },
      catalog: { categoryMapping: HIFIDO_CATEGORY_MAPPING },
      activityPolicy: HIFIDO_ACTIVITY_POLICY,
    },
  ),
  defineShopPlugin(
    forMusicAdapter,
    {
      key: "formusic",
      name: "FOR MUSIC",
      baseUrl: "https://shop.formusic.jp",
      defaultIntervalMinutes: 30,
    },
    { catalog: { categoryMapping: FORMUSIC_CATEGORY_MAPPING } },
  ),
  defineShopPlugin(
    uAudioAdapter,
    {
      key: "u-audio",
      name: "U-AUDIO",
      baseUrl: "https://www.u-audio.com",
      defaultIntervalMinutes: 60,
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
      defaultIntervalMinutes: 60,
      defaultMaxPages: 20,
    },
    { catalog: { categoryPolicy: SHIMAMUSEN_CATEGORY_POLICY } },
  ),
  // shop-generator:plugins
]);

export function getShopPlugin(shopKey: string | null | undefined): ShopPlugin | null {
  return SHOP_PLUGINS.find((plugin) => plugin.key === shopKey) || null;
}
