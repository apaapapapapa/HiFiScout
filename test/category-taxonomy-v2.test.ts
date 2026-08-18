import test from "node:test";
import assert from "node:assert/strict";

import {
  CATEGORIES,
  categoryClosureIds,
  categoryIdForFilter,
  getCategory,
} from "../src/catalog/categories.js";
import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { parsedProduct } from "./helpers/fixtures.js";

const top = () => CATEGORIES.filter((category) => category.parentId == null);
const children = (parentId: string) =>
  CATEGORIES.filter((category) => category.parentId === parentId);

function classify(title: string) {
  return normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "",
      rawManufacturer: "",
      title,
      category: "",
      rawCategory: "",
    }),
    { categoryPolicy: { parserHint: "ignore", sellerCategory: { default: "corroborative" } } },
  );
}

test("top-level taxonomy has explicit required order", () => {
  assert.deepEqual(
    top().map((category) => category.id),
    [
      "amplifier",
      "digital",
      "analog",
      "speaker",
      "headphone_group",
      "accessories",
      "dj_dtm",
      "other",
    ],
  );
  assert.deepEqual(
    top().map((category) => category.order),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test("group parents are filterable but never classifiable", () => {
  for (const id of [
    "amplifier",
    "digital",
    "analog",
    "speaker",
    "headphone_group",
    "accessories",
    "cable",
  ]) {
    const category = getCategory(id);
    assert.ok(category);
    assert.equal(category.classifiable, false);
    assert.equal(category.filterable, true);
  }
  const groupIds = new Set([
    "amplifier",
    "digital",
    "analog",
    "speaker",
    "headphone_group",
    "accessories",
    "cable",
  ]);
  assert.ok(
    CATEGORIES.filter((category) => !groupIds.has(category.id)).every(
      (category) => category.classifiable,
    ),
  );
});

test("children retain required definition order", () => {
  assert.deepEqual(
    children("amplifier").map((category) => category.id),
    ["integrated_amp", "pre_amp", "power_amp", "headphone_amp", "av_amp"],
  );
  assert.deepEqual(
    children("digital").map((category) => category.id),
    [
      "dac",
      "network_player",
      "cd_sacd_player",
      "dap",
      "network_switch",
      "optical_isolator",
      "router",
      "music_server",
      "master_clock",
    ],
  );
  assert.deepEqual(
    children("speaker").map((category) => category.id),
    ["speaker_bookshelf", "speaker_floorstanding", "center_speaker", "subwoofer", "active_speaker"],
  );
  assert.deepEqual(
    children("accessories").map((category) => category.id),
    ["cable", "rack", "power_accessory", "vacuum_tube", "other_accessory"],
  );
  assert.deepEqual(
    children("cable").map((category) => category.id),
    [
      "cable_xlr",
      "cable_rca",
      "cable_phono",
      "cable_usb",
      "cable_lan",
      "cable_digital",
      "cable_power",
      "cable_other",
    ],
  );
});

test("legacy category aliases resolve to canonical ids", () => {
  assert.equal(categoryIdForFilter("network_transport"), "network_player");
  assert.equal(categoryIdForFilter("accessory"), "other_accessory");
  assert.equal(categoryIdForFilter("speaker_other"), "speaker");
});

test("search closure contains leaf and every ancestor group", () => {
  assert.deepEqual(categoryClosureIds("pre_amp"), ["pre_amp", "amplifier"]);
  assert.deepEqual(categoryClosureIds("speaker_bookshelf"), ["speaker_bookshelf", "speaker"]);
  assert.deepEqual(categoryClosureIds("dac"), ["dac", "digital"]);
  assert.deepEqual(categoryClosureIds("cable_xlr"), ["cable_xlr", "cable", "accessories"]);
});

test("composite amplifier titles keep one product category and expose features separately", () => {
  const pre = classify("DAC内蔵 プリアンプ XXXXX");
  assert.equal(pre.primaryCategoryId, "pre_amp");
  assert.deepEqual(pre.categoryIds, ["pre_amp"]);
  assert.equal(pre.featureFacts.find((fact) => fact.featureId === "dac")?.state, "present");

  const integrated = classify("DAC搭載 プリメインアンプ YYYY");
  assert.equal(integrated.primaryCategoryId, "integrated_amp");
  assert.deepEqual(integrated.categoryIds, ["integrated_amp"]);
  assert.equal(integrated.featureFacts.find((fact) => fact.featureId === "dac")?.state, "present");
});

test("transports are classified as their player family", () => {
  assert.equal(classify("Network Transport N1").primaryCategoryId, "network_player");
  assert.equal(classify("CD Transport D1").primaryCategoryId, "cd_sacd_player");
});

test("digital network infrastructure and server titles use dedicated categories", () => {
  assert.deepEqual(inferExplicitCategoryIds("Silent Angel N8 Network Switch"), ["network_switch"]);
  assert.deepEqual(inferExplicitCategoryIds("光アイソレーター OPT ISO BOX"), ["optical_isolator"]);
  assert.deepEqual(inferExplicitCategoryIds("Audio Router R1"), ["router"]);
  assert.deepEqual(inferExplicitCategoryIds("DELA Music Server N1"), ["music_server"]);
  assert.deepEqual(inferExplicitCategoryIds("G-02 Master Clock Generator"), ["master_clock"]);
});

test("official product classes resolve into the canonical taxonomy rather than extending it", () => {
  // Manufacturer pages name product classes the UI taxonomy deliberately does not carry. Each has
  // to land on an existing category instead of introducing one.
  assert.deepEqual(inferExplicitCategoryIds("DHT-S217 Soundbar", { context: "detail" }), ["other"]);
  assert.deepEqual(inferExplicitCategoryIds("T-11 FM Stereo Tuner", { context: "detail" }), [
    "other",
  ]);
  assert.deepEqual(
    inferExplicitCategoryIds("DF-65 Digital Frequency Dividing Network", { context: "detail" }),
    ["other"],
  );
  assert.deepEqual(
    inferExplicitCategoryIds("DG-68 Digital Voicing Equalizer", { context: "detail" }),
    ["other"],
  );
  assert.deepEqual(inferExplicitCategoryIds("G-02 Master Clock Generator", { context: "detail" }), [
    "master_clock",
  ]);
  assert.deepEqual(inferExplicitCategoryIds("RX-V4A AV Receiver", { context: "detail" }), [
    "av_amp",
  ]);
  assert.deepEqual(inferExplicitCategoryIds("GT-2000 ダストカバー", { context: "title" }), [
    "other_accessory",
  ]);
});

test("speaker classification uses the requested five canonical leaves", () => {
  assert.equal(classify("Bookshelf Speaker Model A").primaryCategoryId, "speaker_bookshelf");
  assert.equal(
    classify("Floorstanding Speaker Model B").primaryCategoryId,
    "speaker_floorstanding",
  );
  assert.equal(classify("Center Speaker Model C").primaryCategoryId, "center_speaker");
  assert.equal(classify("Subwoofer Model D").primaryCategoryId, "subwoofer");
  assert.equal(classify("Active Speaker Model E").primaryCategoryId, "active_speaker");
  assert.equal(classify("Active Bookshelf Speaker Model F").primaryCategoryId, "active_speaker");
  assert.equal(classify("Speaker Model G").primaryCategoryId, "other");
  assert.equal(classify("SUB Model H").primaryCategoryId, "other");
  assert.equal(getCategory("speaker_floorstanding")?.name, "フロア型・トールボーイ");
});

test("cable classification uses the requested eight canonical leaves", () => {
  assert.equal(classify("XLRケーブル 1m").primaryCategoryId, "cable_xlr");
  assert.equal(classify("RCAケーブル 1m").primaryCategoryId, "cable_rca");
  assert.equal(classify("フォノケーブル 1.2m").primaryCategoryId, "cable_phono");
  assert.equal(classify("USBケーブル Type-B 1m").primaryCategoryId, "cable_usb");
  assert.equal(classify("LANケーブル CAT8 2m").primaryCategoryId, "cable_lan");
  assert.equal(classify("AES/EBU デジタルケーブル 1m").primaryCategoryId, "cable_digital");
  assert.equal(classify("電源ケーブル 1.5m").primaryCategoryId, "cable_power");
  assert.equal(classify("スピーカーケーブル 3m").primaryCategoryId, "cable_other");
  assert.equal(classify("ヘッドホンケーブル 2m").primaryCategoryId, "cable_other");
});

test("generic seller cable buckets do not override a specific title cable type", () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "",
      rawManufacturer: "",
      title: "XLRケーブル 1m",
      category: "",
      rawCategory: "ケーブル",
    }),
    { categoryMapping: { ケーブル: "cable" } },
  );
  assert.equal(product.primaryCategoryId, "cable_xlr");
});

test("accessory precedence prevents target component words from stealing classification", () => {
  assert.equal(classify("電源タップ 6口").primaryCategoryId, "power_accessory");
  assert.equal(classify("インシュレーター 4個").primaryCategoryId, "other_accessory");
});
