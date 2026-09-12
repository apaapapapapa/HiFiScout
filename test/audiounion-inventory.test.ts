import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  audioUnionInventoryRecheck,
  classifyAudioUnionInventoryPage,
  isAudioUnionUsedDetailUrl,
  extractAudioUnionOfferFacts,
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
    "unknown",
  );
  assert.equal(
    classifyAudioUnionInventoryPage("<main>この商品は販売終了しました</main>"),
    "sold_out",
  );
  assert.equal(
    classifyAudioUnionInventoryPage("<main>販売価格 ¥798,000 販売終了</main>"),
    "sold_out",
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

test("the listing status beats a retained price and unrelated purchase controls", () => {
  assert.equal(
    classifyAudioUnionInventoryPage(`<div id="item_info">販売価格 ¥618,000
    <p id="item_info_product_status">この商品は販売済みです</p></div>
    <aside>関連商品 <button>カートに入れる</button></aside>`),
    "sold_out",
  );
  assert.equal(
    classifyAudioUnionInventoryPage(
      '<div id="item_info">販売価格 ¥618,000</div><aside>在庫あり</aside>',
    ),
    "unknown",
  );
  assert.equal(classifyAudioUnionInventoryPage("<main>在庫あり 販売終了</main>"), "unknown");
  assert.equal(
    classifyAudioUnionInventoryPage(
      '<div id="item_info"><p id="item_info_product_status">在庫あり</p></div>',
    ),
    "in_stock",
  );
});

const detail = (
  accessories: string,
  warranty = "６ヶ月",
  condition = "特に目立った傷はございません。",
) => `<div id="used_item_info">
  <div id="accessory_line"><div class="itp_data">${accessories}</div></div>
  <div id="warranty_line"><div class="itp_data">${warranty}</div></div>
  <div id="condition_line"><div class="itp_data">${condition}</div></div></div>`;

test("AudioUnion listing fields retain structured warranty, included items and condition", () => {
  const facts = extractAudioUnionOfferFacts(
    detail("取扱説明書、リモコン、電源ケーブル。"),
    "2026-09-11T00:00:00Z",
  );
  assert.deepEqual(
    facts?.map((f) => [f.factId, f.state, f.warrantyMonths]),
    [
      ["remote_control", "present", undefined],
      ["manual", "present", undefined],
      ["appearance_clean", "present", undefined],
      ["shop_warranty", "present", 6],
    ],
  );
  assert.ok(
    facts?.every(
      (f) =>
        f.source === "seller_detail" &&
        f.sourceField.startsWith("detail_") &&
        !JSON.stringify(f).includes("電源ケーブル"),
    ),
  );
  assert.equal(
    extractAudioUnionOfferFacts(detail("リモコン（RD-29）、元箱なし", "1年"), "2026-09-11")?.find(
      (f) => f.factId === "shop_warranty",
    )?.warrantyMonths,
    12,
  );
});

test("model specifications, generic guarantees and ambiguous accessories prove no listing facts", () => {
  assert.equal(
    extractAudioUnionOfferFacts(
      '<div id="spec_text">リモコンあり</div><footer>全商品６ヶ月保証</footer>',
      "2026-09-11",
    ),
    null,
  );
  assert.equal(
    extractAudioUnionOfferFacts(
      '<script><div id="used_item_info">リモコンあり</div></script>',
      "2026-09-11",
    ),
    null,
  );
  for (const value of [
    "リモコン（欠品）",
    "リモコン（動作未確認）",
    "リモコン対応",
    "リモコンなし、リモコン",
    "取扱説明書についてはお問い合わせください",
  ])
    assert.deepEqual(
      extractAudioUnionOfferFacts(detail(value, "保証はお問い合わせください", ""), "2026-09-11"),
      [],
      value,
    );
  assert.deepEqual(extractAudioUnionOfferFacts(detail("", "999年", ""), "2026-09-11"), []);
  assert.equal(
    extractAudioUnionOfferFacts(detail("", "保証なし", ""), "2026-09-11")?.[0].state,
    "absent",
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
