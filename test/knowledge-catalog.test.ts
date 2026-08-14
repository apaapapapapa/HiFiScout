import test from "node:test";
import assert from "node:assert/strict";

import { classifyCategoryEvidence } from "../src/catalog/category-classifier.js";
import {
  buildKnowledgeCatalogCandidateAggregates,
  candidatePriority,
  catalogModelLookupVariants,
  knowledgeCatalogEvidence,
  knowledgeCatalogKey,
  normalizeCatalogModel,
} from "../src/catalog/knowledge-catalog.js";
import {
  knowledgeCatalogReviewModeOptions,
  summarizeClassificationImpact,
} from "../src/knowledge-catalog-review.js";

test("model normalization standardizes safe punctuation variants without erasing identity", () => {
  assert.equal(normalizeCatalogModel("K - 01XD"), "K-01XD");
  assert.equal(normalizeCatalogModel("K‐01XD"), "K-01XD");
  assert.notEqual(normalizeCatalogModel("K-01XD"), normalizeCatalogModel("K01XD"));
  assert.notEqual(normalizeCatalogModel("2.5"), normalizeCatalogModel("25"));
  assert.notEqual(normalizeCatalogModel("K-01X"), normalizeCatalogModel("K-01XD"));
  assert.notEqual(normalizeCatalogModel("D8000 Pro"), normalizeCatalogModel("D8000 Pro LE"));
});

test("catalog keys require both normalized manufacturer and model identity", () => {
  assert.equal(knowledgeCatalogKey("esoteric", "K - 01XD"), "esoteric:K-01XD");
  assert.equal(knowledgeCatalogKey("", "K-01XD"), "");
  assert.equal(knowledgeCatalogKey("esoteric", ""), "");
});

test("Marantz lookup aliases remove retailer market suffixes and restore official model spacing", () => {
  const variants = catalogModelLookupVariants({ manufacturerId: "marantz", model: "SACD10/FB" });
  assert.ok(variants.includes("SACD10/FB"));
  assert.ok(variants.includes("SACD10"));
  assert.ok(variants.includes("SACD 10"));

  const model10 = catalogModelLookupVariants({ manufacturerId: "marantz", model: "MODEL10/FN" });
  assert.ok(model10.includes("MODEL10"));
  assert.ok(model10.includes("MODEL 10"));

  // The rule is manufacturer-scoped; a slash suffix on an unrelated brand remains part of identity.
  assert.deepEqual(
    catalogModelLookupVariants({ manufacturerId: "other-brand", model: "SACD10/FB" }),
    ["SACD10/FB"],
  );
});

test("lookup aliases remove listing-only presentation suffixes conservatively", () => {
  const variants = (manufacturerId: string, model: string) =>
    catalogModelLookupVariants({ manufacturerId, model });

  assert.ok(variants("denon", "DP-400-BK [DP400BKEM]").includes("DP-400"));
  assert.ok(variants("denon", "DCD-755RE-SP").includes("DCD-755RE"));
  assert.ok(variants("denon", "DL-103《JP-u》【販売済】").includes("DL-103"));
  assert.ok(variants("denon", "RCD-N12/ブラック").includes("RCD-N12"));
  assert.ok(variants("denon", "PerL Pro/ホワイト").includes("PERL PRO"));
  assert.ok(variants("denon", "AH-D9200EM").includes("AH-D9200"));
});

test("lookup aliases preserve meaningful revisions and do not reinterpret accessories", () => {
  const variants = (manufacturerId: string, model: string) =>
    catalogModelLookupVariants({ manufacturerId, model });

  assert.ok(variants("yamaha", "YH-5000SE(B)").includes("YH-5000SE"));
  assert.ok(variants("accuphase", "C-2800+AD-290V").includes("C-2800"));
  assert.ok(variants("esoteric", "K-01XD").includes("K-01XD"));
  assert.ok(variants("final", "D8000 Pro Limited Edition").includes("D8000 PRO LIMITED EDITION"));
  // An accessory is not a variant of the component it names.
  assert.deepEqual(variants("yamaha", "GT-2000ダストカバー"), ["GT-2000ダストカバー"]);
});

test("candidate aggregation groups only safely-normalized formatting variants", () => {
  const rows = [
    {
      shop_key: "audiounion",
      manufacturer_id: "esoteric",
      manufacturer: "ESOTERIC",
      model: "K-01XD",
      title: "ESOTERIC K-01XD",
      category_ids: '["cd_sacd_player"]',
      classification_status: "classified",
      first_seen_at: "2026-08-01T00:00:00.000Z",
      last_seen_at: "2026-08-10T00:00:00.000Z",
    },
    {
      shop_key: "hifido",
      manufacturer_id: "esoteric",
      manufacturer: "ESOTERIC",
      model: "K‐01XD",
      title: "ESOTERIC K‐01XD",
      category_ids: "[]",
      classification_status: "unclassified",
      first_seen_at: "2026-08-02T00:00:00.000Z",
      last_seen_at: "2026-08-11T00:00:00.000Z",
    },
    {
      shop_key: "hifido",
      manufacturer_id: "esoteric",
      manufacturer: "ESOTERIC",
      model: "K-01X",
      title: "ESOTERIC K-01X",
      category_ids: '["cd_sacd_player"]',
      classification_status: "classified",
      first_seen_at: "2026-08-03T00:00:00.000Z",
      last_seen_at: "2026-08-09T00:00:00.000Z",
    },
  ];

  const candidates = buildKnowledgeCatalogCandidateAggregates(rows);
  assert.equal(candidates.length, 2);
  const xd = candidates.find((candidate) => candidate.normalizedModel === "K-01XD");
  assert.ok(xd);
  assert.equal(xd.listingCount, 2);
  assert.equal(xd.shopCount, 2);
  assert.equal(xd.unclassifiedCount, 1);
  assert.equal(xd.otherCount, 0);
  assert.deepEqual(xd.categoryIds, ["cd_sacd_player"]);
  assert.equal(xd.firstSeenAt, "2026-08-01T00:00:00.000Z");
  assert.equal(xd.lastSeenAt, "2026-08-11T00:00:00.000Z");
  assert.equal(xd.priorityScore, candidatePriority(xd));
});

test("classified other listings receive catalog review priority without double-counting unclassified rows", () => {
  const candidates = buildKnowledgeCatalogCandidateAggregates([
    {
      shop_key: "fujiya-avic",
      manufacturer_id: "marantz",
      manufacturer: "Marantz",
      model: "SACD10/FB",
      title: "Marantz SACD10/FB",
      category_ids: '["other"]',
      classification_status: "classified",
      first_seen_at: "2026-08-01T00:00:00.000Z",
      last_seen_at: "2026-08-12T00:00:00.000Z",
    },
    {
      shop_key: "hifido",
      manufacturer_id: "marantz",
      manufacturer: "Marantz",
      model: "UNKNOWN-1",
      title: "Marantz UNKNOWN-1",
      category_ids: "[]",
      classification_status: "unclassified",
      first_seen_at: "2026-08-01T00:00:00.000Z",
      last_seen_at: "2026-08-12T00:00:00.000Z",
    },
  ]);

  const other = candidates.find((candidate) => candidate.normalizedModel === "SACD10/FB");
  const unclassified = candidates.find((candidate) => candidate.normalizedModel === "UNKNOWN-1");
  assert.ok(other);
  assert.ok(unclassified);
  assert.equal(other.otherCount, 1);
  assert.equal(other.unclassifiedCount, 0);
  assert.equal(unclassified.otherCount, 0);
  assert.equal(unclassified.unclassifiedCount, 1);
  assert.equal(other.priorityScore, 91);
  assert.equal(unclassified.priorityScore, 111);
});

test("verified catalog evidence overrides a conflicting seller category", () => {
  const catalogEvidence = knowledgeCatalogEvidence({
    canonicalName: "SACD 10",
    canonicalModel: "SACD 10",
    categoryIds: ["cd_sacd_player"],
  });
  const result = classifyCategoryEvidence([
    { categoryId: "dap", source: "seller_category", strength: "authoritative", value: "DAP" },
    ...catalogEvidence,
  ]);
  assert.equal(result.classificationStatus, "classified");
  assert.equal(result.primaryCategoryId, "cd_sacd_player");
  assert.deepEqual(result.categoryIds, ["cd_sacd_player"]);
  assert.equal(result.classificationSource, "knowledge_catalog");
});

test("legacy multi-category catalog evidence is reduced to one primary category", () => {
  const result = classifyCategoryEvidence(
    knowledgeCatalogEvidence({
      canonicalName: "Network DAC",
      canonicalModel: "ND-1",
      categoryIds: ["dac", "network_player"],
    }),
  );
  assert.equal(result.classificationStatus, "classified");
  assert.equal(result.primaryCategoryId, "dac");
  assert.deepEqual(result.categoryIds, ["dac"]);
});

test("classification impact reports only reductions", () => {
  assert.deepEqual(
    summarizeClassificationImpact(
      { unclassifiedProducts: 12, otherProducts: 20 },
      { unclassifiedProducts: 7, otherProducts: 16 },
    ),
    { unclassifiedReduced: 5, otherReduced: 4 },
  );
  assert.deepEqual(
    summarizeClassificationImpact(
      { unclassifiedProducts: 4, otherProducts: 2 },
      { unclassifiedProducts: 6, otherProducts: 3 },
    ),
    { unclassifiedReduced: 0, otherReduced: 0 },
  );
});

test("daily catalog mode verifies candidates without marking or rechecking verified products", () => {
  assert.deepEqual(knowledgeCatalogReviewModeOptions("daily_candidates"), {
    mode: "daily_candidates",
    markDueProducts: false,
    verifyCandidates: true,
    verifyDueProducts: false,
  });
});

test("monthly catalog mode rechecks verified products without consuming candidate verification capacity", () => {
  assert.deepEqual(knowledgeCatalogReviewModeOptions("monthly_recheck"), {
    mode: "monthly_recheck",
    markDueProducts: true,
    verifyCandidates: false,
    verifyDueProducts: true,
  });
});
