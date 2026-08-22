import test from "node:test";
import assert from "node:assert/strict";

import { syncShopRows } from "../frontend/product-view.js";
import { SHOP_FILTER_READINGS, sortShopsByJapaneseReading } from "../frontend/shop-options.js";
import type { MetaShop } from "../src/api/contracts.js";
import { SHOP_PLUGINS } from "../src/crawler/shops/index.js";

const GOJUON_KEYS = [
  "avac",
  "afroaudio",
  "ippinkan",
  "audio-space-core",
  "audiounion",
  "osakaya",
  "sound-support",
  "soundpit",
  "shimamusen",
  "dynamic-audio",
  "tereon",
  "hifido",
  "formusic",
  "fujiya-avic",
  "u-audio",
] as const;

function shop(key: string, name: string) {
  return { key, name };
}

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

test("shop readings cover every registered shop", () => {
  assert.deepEqual(
    Object.keys(SHOP_FILTER_READINGS).sort(),
    SHOP_PLUGINS.map((plugin) => plugin.key).sort(),
  );
});

test("shop search filter follows Japanese gojuon reading order", () => {
  const shops = SHOP_PLUGINS.map((plugin) => shop(plugin.key, plugin.name));

  assert.deepEqual(
    sortShopsByJapaneseReading(shops).map((entry) => entry.key),
    GOJUON_KEYS,
  );
});

test("sync status details follows the same Japanese gojuon reading order", () => {
  const shops = SHOP_PLUGINS.map((plugin) => metaShop(plugin.key, plugin.name));
  const namesByKey = new Map(SHOP_PLUGINS.map((plugin) => [plugin.key, plugin.name]));
  const markup = syncShopRows(shops, Date.UTC(2026, 7, 22, 0, 0, 0));
  const renderedNames = [...markup.matchAll(/<span class="sync-shop-name">([^<]+)<\/span>/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(
    renderedNames,
    GOJUON_KEYS.map((key) => namesByKey.get(key)),
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
