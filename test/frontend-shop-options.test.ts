import test from "node:test";
import assert from "node:assert/strict";

import { SHOP_FILTER_READINGS, sortShopsByJapaneseReading } from "../frontend/shop-options.js";
import { SHOP_PLUGINS } from "../src/crawler/shops/index.js";

function shop(key: string, name: string) {
  return { key, name };
}

test("shop search-filter readings cover every registered shop", () => {
  assert.deepEqual(
    Object.keys(SHOP_FILTER_READINGS).sort(),
    SHOP_PLUGINS.map((plugin) => plugin.key).sort(),
  );
});

test("shop search filter follows Japanese gojuon reading order", () => {
  const shops = SHOP_PLUGINS.map((plugin) => shop(plugin.key, plugin.name));

  assert.deepEqual(
    sortShopsByJapaneseReading(shops).map((entry) => entry.key),
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

test("sorting does not mutate the source order used by other UI surfaces", () => {
  const shops = [shop("hifido", "ハイファイ堂"), shop("avac", "アバック")];
  const originalKeys = shops.map((entry) => entry.key);

  const sorted = sortShopsByJapaneseReading(shops);

  assert.deepEqual(
    shops.map((entry) => entry.key),
    originalKeys,
  );
  assert.deepEqual(
    sorted.map((entry) => entry.key),
    ["avac", "hifido"],
  );
  assert.notEqual(sorted, shops);
});
