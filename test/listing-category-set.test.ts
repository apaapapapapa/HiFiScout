import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { classifyCategoryEvidence } from "../src/catalog/category-classifier.js";
import { collectListingCategoryEvidence } from "../src/catalog/category-evidence.js";
import { applyCategoryClassification } from "../src/catalog/product-normalizer.js";
import {
  componentCategoryIds,
  detectListingComponents,
  listingCategoryClosureIds,
  listingCategorySet,
  listingDirectCategoryIds,
  listingPrimaryCategoryId,
} from "../src/catalog/listing-components.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import type { CategoryClassification } from "../src/catalog/types.js";

function componentsOf(title: string) {
  return detectListingComponents({ title }, {}).components;
}

function classificationOf(title: string): CategoryClassification {
  const { evidence } = collectListingCategoryEvidence({
    rawCategory: "",
    title,
    hintedCategory: "",
  });
  return classifyCategoryEvidence(evidence);
}

test("a component's own text decides its category", () => {
  // In component order, not taxonomy order: this is the raw per-component reading.
  assert.deepEqual(
    componentCategoryIds(
      componentsOf("ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC"),
    ),
    ["SRC.DISC", "PRC.DAC"],
  );
});

test("a component that names no category contributes the unclassified sentinel", () => {
  assert.deepEqual(componentCategoryIds(componentsOf("ESOTERIC Grandioso P1 + Grandioso D1")), [
    "unclassified",
    "unclassified",
  ]);
});

test("one classified component decides the set even when its siblings are silent", () => {
  assert.deepEqual(
    listingDirectCategoryIds(["unclassified", "AMP.POWER", "unclassified"], "unclassified"),
    ["AMP.POWER"],
  );
});

test("a set whose components name nothing falls back to the listing classification", () => {
  assert.deepEqual(listingDirectCategoryIds(["unclassified", "unclassified"], "PRC.DAC"), [
    "PRC.DAC",
  ]);
});

test("a listing with no components is directly in its own primary category", () => {
  assert.deepEqual(listingDirectCategoryIds([], "AMP.INTEGRATED"), ["AMP.INTEGRATED"]);
});

test("the filter closure contains each v3 product type and root once", () => {
  const closure = listingCategoryClosureIds(["SRC.DISC", "PRC.DAC"]);
  assert.deepEqual(closure, ["SRC", "SRC.DISC", "PRC", "PRC.DAC"]);
});

test("the filter closure is ordered by the taxonomy, not by the order it was given", () => {
  assert.deepEqual(
    listingCategoryClosureIds(["PRC.DAC", "SRC.DISC"]),
    listingCategoryClosureIds(["SRC.DISC", "PRC.DAC"]),
  );
});

test("a primary that is still one of the direct categories survives", () => {
  assert.equal(listingPrimaryCategoryId(["SRC.DISC", "PRC.DAC"], "PRC.DAC"), "PRC.DAC");
});

test("a primary the components did not name is replaced from the taxonomy", () => {
  const directIds = listingDirectCategoryIds(["AMP.PRE", "AMP.POWER"], "unclassified");
  assert.equal(listingPrimaryCategoryId(directIds, "unclassified"), directIds[0]);
});

test("a listing with no components keeps every classification field it arrived with", () => {
  const classification = classificationOf("Accuphase E-800 プリメインアンプ");
  const set = listingCategorySet(classification, []);

  assert.equal(set.promoted, false);
  assert.equal(set.primaryCategoryId, classification.primaryCategoryId);
  assert.deepEqual(set.categoryIds, classification.categoryIds);
  assert.equal(set.displayName, classification.displayName);
  assert.equal(set.classificationStatus, classification.classificationStatus);
  assert.equal(set.classificationState, classification.classificationState);
  assert.equal(set.classificationReason, classification.classificationReason);
  assert.equal(set.classificationSource, classification.classificationSource);
  assert.equal(set.searchAliases, classification.searchAliases);
  assert.deepEqual(set.directCategoryIds, [classification.primaryCategoryId]);
});

test("a set the listing classifier already agrees with keeps its representative category", () => {
  // The classifier reads the same title, so it normally lands on one of the component categories
  // and nothing is promoted. Promotion is the exception, covered by the test below.
  const title = "TAD C1000-S プリアンプ + TAC-M1000TX-S パワーアンプ";
  const classification = classificationOf(title);
  const set = listingCategorySet(classification, componentCategoryIds(componentsOf(title)));

  assert.deepEqual(set.directCategoryIds, ["AMP.PRE", "AMP.POWER"]);
  assert.equal(set.promoted, false);
  assert.equal(set.primaryCategoryId, classification.primaryCategoryId);
  assert.equal(set.categoryIds.length, 1, "the single-product classification stays single");
});

test("a representative category none of the components share is replaced, not left dangling", () => {
  const set = listingCategorySet(
    {
      primaryCategoryId: "unclassified",
      categoryIds: [],
      displayName: "未分類",
      classificationStatus: "unclassified",
      classificationState: "unclassified",
      classificationReason: "insufficient_evidence",
      classificationSource: "unclassified",
      candidateCategoryIds: [],
      searchAliases: "",
      confidence: 0,
    },
    ["AMP.PRE", "AMP.POWER"],
  );

  assert.deepEqual(set.directCategoryIds, ["AMP.PRE", "AMP.POWER"]);
  assert.equal(set.promoted, true);
  assert.equal(set.classificationStatus, "classified");
  assert.equal(set.classificationSource, "component_evidence");
  assert.ok(
    set.directCategoryIds.includes(set.primaryCategoryId),
    "a listing's representative category must be one of the categories it is in",
  );
  assert.equal(set.categoryIds.length, 1, "the single-product classification stays single");
});

test("normalization carries a set's categories through to the product", () => {
  const normalized = normalizeCatalogProduct({
    sourceId: "set-1",
    manufacturer: "ESOTERIC",
    model: "Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
    title: "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
    conditionText: "中古",
    priceYen: 3000000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/set-1",
  });

  // Taxonomy order, independent of the order in which the seller wrote the components.
  assert.deepEqual(normalized.directCategoryIds, ["SRC.DISC", "PRC.DAC"]);
  assert.equal(normalized.categoryIds.length, 1);
  assert.ok(normalized.directCategoryIds.includes(normalized.primaryCategoryId));
});

test("normalizing a single product leaves it in exactly one direct category", () => {
  const normalized = normalizeCatalogProduct({
    sourceId: "single-1",
    manufacturer: "Marantz",
    model: "PM-14S1",
    title: "Marantz PM-14S1 プリメインアンプ",
    conditionText: "中古",
    priceYen: 100000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/single-1",
  });

  assert.deepEqual(normalized.directCategoryIds, [normalized.primaryCategoryId]);
  assert.equal(normalized.primaryCategoryId, "AMP.INTEGRATED");
});

test("a DAC-equipped integrated amplifier is one product in one category", () => {
  const normalized = normalizeCatalogProduct({
    sourceId: "single-2",
    manufacturer: "LUXMAN",
    model: "L-507Z",
    title: "LUXMAN L-507Z DAC搭載プリメインアンプ",
    conditionText: "中古",
    priceYen: 500000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/single-2",
  });

  assert.equal(normalized.directCategoryIds.length, 1);
});

/**
 * The crawler's enricher fetches a detail page and applies a second, better classification to an
 * already-normalized product. A set must survive that: the detail page describes one sale, and the
 * components it contains did not change because someone read more of the seller's text.
 */
test("re-classifying an already-normalized set keeps its component categories", () => {
  const title = "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC";
  const normalized = normalizeCatalogProduct({
    sourceId: "set-enriched",
    manufacturer: "ESOTERIC",
    model: title,
    title,
    conditionText: "中古",
    priceYen: 3000000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/set-enriched",
  });
  assert.deepEqual(normalized.directCategoryIds, ["SRC.DISC", "PRC.DAC"]);

  const reclassified = applyCategoryClassification(normalized, {
    primaryCategoryId: "SRC.DISC",
    categoryIds: ["SRC.DISC"],
    displayName: "トランスポート",
    classificationStatus: "classified",
    classificationState: "classified",
    classificationReason: "",
    classificationSource: "detail_page",
    candidateCategoryIds: [],
    searchAliases: "transport",
    confidence: 1,
  });

  assert.deepEqual(reclassified.directCategoryIds, ["SRC.DISC", "PRC.DAC"]);
});

test("the roots of a set's components are materialized once", () => {
  const closure = listingCategoryClosureIds(["SRC.DISC", "PRC.DAC"]);
  assert.equal(closure.filter((id) => id === "SRC").length, 1);
  assert.equal(closure.filter((id) => id === "PRC").length, 1);
  assert.deepEqual(closure, ["SRC", "SRC.DISC", "PRC", "PRC.DAC"]);
});

/**
 * Several adapters extract a concise model field on purpose, and that field is the better source
 * for identity because it carries no prose. But the category words are in the prose, so a
 * component identified from `Grandioso P1` still has to be classified from the stretch of title
 * that names it.
 */
test("a component identified from a concise model is classified from the title", () => {
  const detection = detectListingComponents(
    {
      rawModel: "Grandioso P1 + Grandioso D1",
      title: "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
    },
    {},
  );

  assert.equal(detection.isBundle, true);
  assert.deepEqual(
    detection.components.map((component) => component.segment),
    ["Grandioso P1", "Grandioso D1"],
  );
  assert.deepEqual(componentCategoryIds(detection.components), ["SRC.DISC", "PRC.DAC"]);
});

test("a title that names no component leaves the components unclassified", () => {
  const detection = detectListingComponents(
    { rawModel: "Grandioso P1 + Grandioso D1", title: "オーディオ機器 まとめ" },
    {},
  );

  assert.deepEqual(componentCategoryIds(detection.components), ["unclassified", "unclassified"]);
});

test("one stretch of title cannot classify two components", () => {
  const detection = detectListingComponents(
    { rawModel: "PM-14S1 + PM-14S1SE", title: "Marantz PM-14S1 プリメインアンプ + PM-14S1SE" },
    {},
  );
  const segments = detection.components.map((component) => component.categorySegment);

  assert.equal(new Set(segments).size, segments.length);
});

test("normalizing a set with a concise model field keeps both categories", () => {
  const normalized = normalizeCatalogProduct({
    sourceId: "set-concise",
    manufacturer: "ESOTERIC",
    rawModel: "Grandioso P1 + Grandioso D1",
    model: "Grandioso P1 + Grandioso D1",
    title: "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
    conditionText: "中古",
    priceYen: 3000000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/set-concise",
  });

  assert.deepEqual(normalized.directCategoryIds, ["SRC.DISC", "PRC.DAC"]);
});
