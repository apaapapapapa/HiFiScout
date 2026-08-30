import { test } from "vite-plus/test";
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

// --- G-1: v3 has one broad loudspeaker product type and independent properties -------------------

test("a generic speaker title lands on the broad loudspeaker product type", () => {
  for (const title of ["2Wayスピーカー", "JBL 2115Aスピーカー", "PCスピーカー", "Speaker System"]) {
    const product = classify(title);
    assert.equal(product.classificationStatus, "classified", title);
    assert.equal(product.primaryCategoryId, "SPK.LOUDSPEAKER", title);
  }
});

test("speaker shapes become facets while subwoofers and soundbars remain product types", () => {
  assert.equal(classify("サウンドバー YAS-109").primaryCategoryId, "SPK.SOUNDBAR");
  assert.equal(classify("JBL Sound Bar SB-1").primaryCategoryId, "SPK.SOUNDBAR");
  assert.equal(
    classify("KEF ブックシェルフ型スピーカー LS50").primaryCategoryId,
    "SPK.LOUDSPEAKER",
  );
  assert.equal(classify("フロア型スピーカー Model X").primaryCategoryId, "SPK.LOUDSPEAKER");
  assert.equal(classify("センタースピーカー NS-C210").primaryCategoryId, "SPK.LOUDSPEAKER");
  assert.equal(classify("サブウーファー SW-1").primaryCategoryId, "SPK.SUBWOOFER");
  const active = classify("アクティブスピーカー AS-1");
  assert.equal(active.primaryCategoryId, "SPK.LOUDSPEAKER");
  assert.ok(
    active.facetFacts.some(
      (fact) => fact.facetId === "amplification_mode" && fact.value === "active",
    ),
  );
  assert.equal(classify("スピーカーケーブル 3m").primaryCategoryId, "CAB.SPEAKER");
});

test("the speaker root is a filter group and the loudspeaker leaf is classifiable", () => {
  const root = getCategory("SPK");
  const loudspeaker = getCategory("SPK.LOUDSPEAKER");
  assert.ok(root);
  assert.ok(loudspeaker);
  assert.equal(root.classifiable, false);
  assert.equal(loudspeaker.classifiable, true);
  assert.equal(categoryIdForClassification("speaker"), "SPK.LOUDSPEAKER");
});

test("a bare speaker seller bucket maps to the broad loudspeaker type", () => {
  for (const rawCategory of ["スピーカー", "speaker", "speaker-system", "中古スピーカー"]) {
    const product = classify("Example Model X", rawCategory);
    assert.equal(product.classificationStatus, "classified", rawCategory);
    assert.equal(product.primaryCategoryId, "SPK.LOUDSPEAKER", rawCategory);
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
    assert.equal(product.primaryCategoryId, "SRC.DAP", title);
    assert.equal(product.classificationStatus, "classified", title);
  }
});

test("the composite DAP bucket alone still classifies nothing", () => {
  const product = classify("Example Model", "DAP・ヘッドホンアンプ");
  assert.equal(product.classificationStatus, "unclassified");
  assert.deepEqual(product.candidateCategoryIds, ["AMP.HEADPHONE"]);
});

test("a model number never outranks an explicit product-type word from the same brand", () => {
  assert.equal(classify("FiiO フィーオ FH19 イヤホン").primaryCategoryId, "PER.EARPHONE");
  assert.equal(classify("FiiO フィーオ LC-RE PRO 交換ケーブル").primaryCategoryId, "unclassified");
  assert.equal(
    classify("Astell&Kern PA10 ポータブルヘッドホンアンプ").primaryCategoryId,
    "AMP.HEADPHONE",
  );
  assert.equal(classify("FiiO フィーオ K11 R2R DAC").primaryCategoryId, "PRC.DAC");
  assert.equal(classify("Shanling シャンリン ME800 イヤホン").primaryCategoryId, "PER.EARPHONE");
});

test("accessories named after a player model are not players", () => {
  for (const title of [
    "Astell&Kern アステルアンドケルン SP2000用 レザーケース",
    "Astell&Kern KANN ULTRA 専用ケース",
    "FiiO フィーオ M23 保護フィルム",
    "HiBy ハイビー R6 III ガラスフィルム",
    "Cayin カイン N7 レザーケース",
  ]) {
    assert.notEqual(inferExplicitCategoryIds(title)[0], "SRC.DAP", title);
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
  assert.equal(bucket.primaryCategoryId, "unclassified");
  assert.deepEqual(bucket.candidateCategoryIds, ["ANA.TURNTABLE"]);
  assert.equal(classify("DENON アナログプレーヤー DP-3000NE").primaryCategoryId, "ANA.TURNTABLE");
});

/**
 * The remaining buckets the audit listed as "mechanically mappable" are already inferred to the
 * right leaf by the rule table; what holds them back is the deliberate demotion of `raw_inference`
 * evidence to the corroborative tier, not a missing mapping. Adding shop mappings would not move
 * them, so this pins where the decision actually lives.
 */
test("a specific seller bucket is still inferred, and still held at the corroborative tier", () => {
  for (const [rawCategory, expected] of [
    ["ブックシェルフスピーカー(ペア)", "SPK.LOUDSPEAKER"],
    ["フロア型スピーカー(ペア)", "SPK.LOUDSPEAKER"],
    ["管球式フォノイコライザー", "AMP.PHONO"],
    ["ステレオパワーアンプ", "AMP.POWER"],
  ] as const) {
    assert.equal(inferExplicitCategoryIds(rawCategory)[0], expected, rawCategory);
    const product = classify("Example Model X", rawCategory);
    assert.equal(product.classificationStatus, "unclassified", rawCategory);
    assert.deepEqual(product.candidateCategoryIds, [expected], rawCategory);
  }
});

test("a coarse bucket still yields to a title that does name a product type", () => {
  const product = classify("LUXMAN プリメインアンプ L-507Z", "アンプ・スピーカー・プレーヤー");
  assert.equal(product.primaryCategoryId, "AMP.INTEGRATED");
  assert.equal(product.classificationStatus, "classified");
});
