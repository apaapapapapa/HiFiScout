import test from "node:test";
import assert from "node:assert/strict";

import {
  SHOP_FILTER_READINGS,
  sortShopsByJapaneseReading,
} from "../frontend/shop-options.js";
import { SHOP_PLUGINS } from "../src/crawler/shops/index.js";
import type { MetaShop } from "../src/api/contracts.js";

function metaShop(key: string, name: string): MetaShop {
  return {
    key,
    name,
    enabled: true,
    intervalMinutes: 60,
    sync: null,
    health: null,
  };
}

test("shop search-filter readings cover every registered shop", () => {
  assert.deepEqual(
    Object.keys(SHOP_FILTER_READINGS).sort(),
    SHOP_PLUGINS.map((plugin) => plugin.key).sort(),
  );
});

test("shop search filter follows Japanese gojuon reading order", () => {
  const shops = SHOP_PLUGINS.map((plugin) => metaShop(plugin.key, plugin.name));

  assert.deepEqual(
    sortShopsByJapaneseReading(shops).map((shop) => shop.key),
    [
      "avac",
      "afroaudio",
      "ippinkan",
      "audiounion",
      "osakaya",
      "soundpit",
      "shimamusen",
      "dynamic-audio",
      "hifido",
      "formusic",
      "fujiya-avic",
      "u-audio",
    ],
  );
});

test("sorting does not mutate the meta shop order used by other UI surfaces", () => {
  const shops = [metaShop("hifido", "ハイファイ堂"), metaShop("avac", "アバック")];
  const originalKeys = shops.map((shop) => shop.key);

  const sorted = sortShopsByJapaneseReading(shops);

  assert.deepEqual(shops.map((shop) => shop.key), originalKeys);
  assert.deepEqual(sorted.map((shop) => shop.key), ["avac", "hifido"]);
  assert.notEqual(sorted, shops);
});
