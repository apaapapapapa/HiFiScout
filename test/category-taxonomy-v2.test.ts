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
      // The "not classified" sentinel sorts last and is neither filterable nor classifiable.
      "unclassified",
    ],
  );
  assert.deepEqual(
    top().map((category) => category.order),
    [1, 2, 3, 4, 5, 6, 7, 8, 99],
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
  // Everything that is not a group parent is a classifiable leaf, except the sentinel: it is the
  // classifier's "no answer", so no classifier may target it.
  assert.ok(
    CATEGORIES.filter(
      (category) => !groupIds.has(category.id) && category.id !== "unclassified",
    ).every((category) => category.classifiable),
  );
  const unclassified = getCategory("unclassified");
  assert.ok(unclassified);
  assert.equal(unclassified.classifiable, false);
  assert.equal(unclassified.filterable, false);
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
      "transport",
      "dap",
      "network_switch",
      "optical_isolator",
      "router",
      "music_server",
      "master_clock",
    ],
  );
  assert.deepEqual(
    children("analog").map((category) => category.id),
    ["turntable", "tonearm", "cartridge", "phono_eq", "phono_step_up_transformer"],
  );
  assert.deepEqual(
    children("speaker").map((category) => category.id),
    ["speaker_bookshelf", "speaker_floorstanding", "center_speaker", "subwoofer", "active_speaker"],
  );
  assert.deepEqual(
    children("headphone_group").map((category) => category.id),
    ["wired_headphone", "wired_earphone", "btw_headphone", "btw_earphone"],
  );
  assert.deepEqual(
    children("accessories").map((category) => category.id),
    ["cable", "rack", "power_strip", "clean_power", "vacuum_tube", "other_accessory"],
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
  assert.equal(categoryIdForFilter("network_transport"), "transport");
  assert.equal(categoryIdForFilter("cd_sacd_transport"), "transport");
  assert.equal(getCategory("cd_sacd_transport")?.id, "transport");
  assert.equal(
    CATEGORIES.map((category) => String(category.id)).includes("cd_sacd_transport"),
    false,
  );
  assert.equal(categoryIdForFilter("accessory"), "other_accessory");
  assert.equal(categoryIdForFilter("speaker_other"), "speaker");
  assert.equal(categoryIdForFilter("headphone"), "wired_headphone");
  assert.equal(categoryIdForFilter("earphone"), "wired_earphone");
  assert.equal(categoryIdForFilter("power_accessory"), "clean_power");
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

test("disc and network transports share one transport category independent from players", () => {
  assert.equal(classify("Network Transport N1").primaryCategoryId, "transport");
  assert.equal(classify("ネットワークトランスポート N2").primaryCategoryId, "transport");
  assert.equal(classify("Streaming Transport N3").primaryCategoryId, "transport");
  assert.equal(classify("CD Transport D1").primaryCategoryId, "transport");
  assert.equal(classify("SACD Player D2").primaryCategoryId, "cd_sacd_player");
  assert.equal(classify("Network Player P1").primaryCategoryId, "network_player");
  assert.equal(getCategory("transport")?.name, "トランスポート");
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
  // Neither a generic speaker title nor a bare "SUB" names a leaf, so both stay undecided rather
  // than being frozen under the terminal `other` label. See G-1 in the remediation guide.
  assert.equal(classify("Speaker Model G").primaryCategoryId, "unclassified");
  assert.equal(classify("SUB Model H").primaryCategoryId, "unclassified");
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

test("headphone, phono and power refinements classify into their dedicated leaves", () => {
  assert.equal(classify("有線ヘッドホン MDR-1").primaryCategoryId, "wired_headphone");
  assert.equal(classify("有線イヤホン IER-1").primaryCategoryId, "wired_earphone");
  assert.equal(classify("Bluetooth ワイヤレスヘッドホン WH-1").primaryCategoryId, "btw_headphone");
  assert.equal(classify("完全ワイヤレスイヤホン WF-1").primaryCategoryId, "btw_earphone");
  assert.equal(classify("MC昇圧トランス T-1").primaryCategoryId, "phono_step_up_transformer");
  assert.equal(classify("フォノイコライザー EQ-1").primaryCategoryId, "phono_eq");
  assert.equal(classify("電源タップ 6口").primaryCategoryId, "power_strip");
  assert.equal(classify("クリーン電源 Power Conditioner P-1").primaryCategoryId, "clean_power");
  assert.equal(classify("インシュレーター 4個").primaryCategoryId, "other_accessory");
});
