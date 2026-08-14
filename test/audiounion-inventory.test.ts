import test from "node:test";
import assert from "node:assert/strict";
import {
  audioUnionInventoryRecheck,
  classifyAudioUnionInventoryPage,
  isAudioUnionUsedDetailUrl,
} from "../src/crawler/shops/audiounion-inventory.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { shopEnvVarName } from "../src/config.js";

const DETAIL_URL = "https://www.audiounion.jp/ct/detail/used/223257/";

test("AudioUnion detail URL validation is intentionally narrow", () => {
  assert.equal(isAudioUnionUsedDetailUrl(DETAIL_URL), true);
  assert.equal(isAudioUnionUsedDetailUrl("https://www.audiounion.jp/ct/detail/used/223257"), true);
  assert.equal(isAudioUnionUsedDetailUrl("https://www.audiounion.jp/ct/search/"), false);
  assert.equal(isAudioUnionUsedDetailUrl("https://www.audiounion.jp/ct/detail/new/223257/"), false);
  assert.equal(isAudioUnionUsedDetailUrl("https://www.audiounion.jp/ct/detail/used/abc/"), false);
  assert.equal(isAudioUnionUsedDetailUrl(`${DETAIL_URL}?x=1`), false);
});

test("inventory page classification uses the canonical availability tri-state", () => {
  assert.equal(
    classifyAudioUnionInventoryPage("<main>販売価格 <strong>¥798,000</strong></main>"),
    "in_stock",
  );
  assert.equal(
    classifyAudioUnionInventoryPage("<main>この商品は販売終了しました</main>"),
    "sold_out",
  );
  assert.equal(
    classifyAudioUnionInventoryPage("<main>販売価格 ¥798,000 販売終了</main>"),
    "unknown",
  );
  assert.equal(
    classifyAudioUnionInventoryPage('<script>const state="販売終了"</script><main>商品情報</main>'),
    "unknown",
  );
  assert.equal(
    classifyAudioUnionInventoryPage(
      '<script>const state="販売終了"</script ><main>商品情報</main>',
    ),
    "unknown",
  );
  assert.equal(
    classifyAudioUnionInventoryPage(
      '<script>const state="販売終了"</script\t\n data-extra><main>商品情報</main>',
    ),
    "unknown",
  );
});

test("the AudioUnion adapter exposes its recheck policy to the generic loop", () => {
  const plugin = getShopPlugin("audiounion");
  assert.ok(plugin);
  assert.equal(
    plugin.capabilities.inventoryRecheck?.classifyPage,
    audioUnionInventoryRecheck.classifyPage,
  );
  assert.equal(
    shopEnvVarName(plugin.definition, "INVENTORY_RECHECK_ENABLED"),
    "AUDIOUNION_INVENTORY_RECHECK_ENABLED",
  );
  assert.equal(audioUnionInventoryRecheck.isDetailUrl(DETAIL_URL), true);
  assert.equal(audioUnionInventoryRecheck.classifyPage("<main>販売終了</main>"), "sold_out");
});
