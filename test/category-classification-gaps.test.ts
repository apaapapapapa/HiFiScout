import { test } from "vitest";
import assert from "node:assert/strict";

import { categoryIdForClassification, getCategory } from "../src/catalog/categories.js";
import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { FUJIYA_CATEGORY_POLICY } from "../src/crawler/shops/fujiya-avic.js";
import { parsedProduct } from "./helpers/fixtures.js";

function classify(title: string, rawCategory = "") {
  return normalizeCatalogProduct(
    parsedProduct({ title, rawCategory, manufacturer: "", rawManufacturer: "" }),
    { categoryPolicy: FUJIYA_CATEGORY_POLICY },
  );
}

// --- G-1: a generic speaker word must not produce a terminal label -------------------------------

test("a generic speaker title stays undecided instead of being frozen as その他", () => {
  for (const title of ["2Wayスピーカー", "JBL 2115Aスピーカー", "PCスピーカー", "Speaker System"]) {
    const product = classify(title);
    assert.equal(product.classificationStatus, "unclassified", title);
    assert.equal(product.primaryCategoryId, "unclassified", title);
  }
});

test("the speaker rule still resolves the specific leaves and the soundbar it was written for", () => {
  assert.equal(classify("サウンドバー YAS-109").primaryCategoryId, "other");
  assert.equal(classify("JBL Sound Bar SB-1").primaryCategoryId, "other");
  assert.equal(
    classify("KEF ブックシェルフ型スピーカー LS50").primaryCategoryId,
    "speaker_bookshelf",
  );
  assert.equal(classify("フロア型スピーカー Model X").primaryCategoryId, "speaker_floorstanding");
  assert.equal(classify("センタースピーカー NS-C210").primaryCategoryId, "center_speaker");
  assert.equal(classify("サブウーファー SW-1").primaryCategoryId, "subwoofer");
  assert.equal(classify("アクティブスピーカー AS-1").primaryCategoryId, "active_speaker");
  // The cable rules sit above the speaker rule, so this is unaffected by the change.
  assert.equal(classify("スピーカーケーブル 3m").primaryCategoryId, "cable_other");
});

test("no generic classifiable speaker leaf was reintroduced", () => {
  const speaker = getCategory("speaker");
  assert.ok(speaker);
  assert.equal(speaker.classifiable, false, "a その他スピーカー bucket is useless as a filter");
  // The group parent is unreachable as a classification answer, which is what keeps a bare
  // "スピーカー" seller bucket from landing anywhere at all.
  assert.equal(categoryIdForClassification("speaker"), null);
});

test("a bare speaker seller bucket no longer lands on the その他 leaf", () => {
  for (const rawCategory of ["スピーカー", "speaker", "speaker-system", "中古スピーカー"]) {
    const product = classify("Example Model X", rawCategory);
    assert.equal(product.classificationStatus, "unclassified", rawCategory);
    assert.notEqual(product.primaryCategoryId, "other", rawCategory);
  }
});

// --- G-2: brand-anchored DAP model families ------------------------------------------------------

/** The listings the audit named as unambiguous misclassifications. */
const CLEAR_DAP_TITLES = [
  "Cayin カイン N6iii [CAY-N6III]",
  "Cayin カイン N7 [CAY-N7]",
  "Cayin カイン N8ii [CAY-N8II]",
  "HiBy ハイビー R6 III [HIB-R6III]",
  "HiBy ハイビー R3 II [HIB-R3II]",
  "HiBy ハイビー R5Gen2 [HIB-R5GEN2]",
  "FiiO フィーオ M23 [FIO-M23]",
  "Astell&Kern アステルアンドケルン KANN ULTRA [AK-KANNULTRA]",
  "LUXURY&PRECISION ラグジュアリーアンドプレシジョン E7 [LP-E7]",
  "Shanling シャンリン M6 Ultra",
  "iBasso アイバッソ DX320",
];

test("named DAP model families classify from the title, not from the composite seller bucket", () => {
  for (const title of CLEAR_DAP_TITLES) {
    // The real listings carry Fujiya's composite bucket, which stays corroborative by policy.
    const product = classify(title, "DAP・ヘッドホンアンプ");
    assert.equal(product.primaryCategoryId, "dap", title);
    assert.equal(product.classificationStatus, "classified", title);
  }
});

test("the composite DAP bucket alone still classifies nothing", () => {
  const product = classify("Example Model", "DAP・ヘッドホンアンプ");
  assert.equal(product.classificationStatus, "unclassified");
  assert.deepEqual(product.candidateCategoryIds, ["headphone_amp"]);
});

test("a model number never outranks an explicit product-type word from the same brand", () => {
  assert.equal(classify("FiiO フィーオ FH19 イヤホン").primaryCategoryId, "wired_earphone");
  assert.equal(classify("FiiO フィーオ LC-RE PRO 交換ケーブル").primaryCategoryId, "cable_other");
  assert.equal(
    classify("Astell&Kern PA10 ポータブルヘッドホンアンプ").primaryCategoryId,
    "headphone_amp",
  );
  assert.equal(classify("FiiO フィーオ K11 R2R DAC").primaryCategoryId, "dac");
  assert.equal(classify("Shanling シャンリン ME800 イヤホン").primaryCategoryId, "wired_earphone");
});

test("accessories named after a player model are not players", () => {
  for (const title of [
    "Astell&Kern アステルアンドケルン SP2000用 レザーケース",
    "Astell&Kern KANN ULTRA 専用ケース",
    "FiiO フィーオ M23 保護フィルム",
    "HiBy ハイビー R6 III ガラスフィルム",
    "Cayin カイン N7 レザーケース",
  ]) {
    assert.notEqual(inferExplicitCategoryIds(title)[0], "dap", title);
  }
});

// --- G-3: coarse seller buckets must stay unclassified -------------------------------------------

/**
 * Buckets too coarse to name a product type. The audit measured 601 active listings behind these,
 * and every one of them is *correctly* unclassified: mapping them would trade a visible gap for an
 * invisible error. Recovery belongs to the title rules, detail enrichment or the Knowledge Catalog.
 */
const COARSE_SELLER_BUCKETS = [
  "アンプ・スピーカー・プレーヤー",
  "中古品",
  "その他オーディオ機器",
  "accessories",
  "中古アクセサリー",
  "ラック・その他",
  "アウトレット",
];

test("coarse seller buckets never classify a listing on their own", () => {
  for (const rawCategory of COARSE_SELLER_BUCKETS) {
    const product = classify("Example Model X", rawCategory);
    assert.equal(product.classificationStatus, "unclassified", rawCategory);
    assert.equal(product.primaryCategoryId, "unclassified", rawCategory);
  }
});

test("アナログプレーヤー names the turntable leaf as a seller bucket and in a title", () => {
  const bucket = classify("Example Model X", "アナログプレーヤー");
  assert.equal(bucket.primaryCategoryId, "turntable");
  assert.equal(bucket.classificationStatus, "classified");
  assert.equal(classify("DENON アナログプレーヤー DP-3000NE").primaryCategoryId, "turntable");
});

/**
 * The remaining buckets the audit listed as "mechanically mappable" are already inferred to the
 * right leaf by the rule table; what holds them back is the deliberate demotion of `raw_inference`
 * evidence to the corroborative tier, not a missing mapping. Adding shop mappings would not move
 * them, so this pins where the decision actually lives.
 */
test("a specific seller bucket is still inferred, and still held at the corroborative tier", () => {
  for (const [rawCategory, expected] of [
    ["ブックシェルフスピーカー(ペア)", "speaker_bookshelf"],
    ["フロア型スピーカー(ペア)", "speaker_floorstanding"],
    ["管球式フォノイコライザー", "phono_eq"],
    ["ステレオパワーアンプ", "power_amp"],
  ] as const) {
    assert.equal(inferExplicitCategoryIds(rawCategory)[0], expected, rawCategory);
    const product = classify("Example Model X", rawCategory);
    assert.equal(product.classificationStatus, "unclassified", rawCategory);
    assert.deepEqual(product.candidateCategoryIds, [expected], rawCategory);
  }
});

test("a coarse bucket still yields to a title that does name a product type", () => {
  const product = classify("LUXMAN プリメインアンプ L-507Z", "アンプ・スピーカー・プレーヤー");
  assert.equal(product.primaryCategoryId, "integrated_amp");
  assert.equal(product.classificationStatus, "classified");
});
