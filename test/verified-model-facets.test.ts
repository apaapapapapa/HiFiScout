import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { verifiedModelFacetFacts } from "../src/catalog/verified-model-facets.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { parsedProduct } from "./helpers/fixtures.js";

const facts = (model: string, overrides = {}) =>
  verifiedModelFacetFacts({
    manufacturerId: "bowers-wilkins",
    model,
    title: `B&W ${model}`,
    primaryCategoryId: "SPK.LOUDSPEAKER",
    ...overrides,
  });

test("reviewed speaker variants receive source-linked form facts without changing identities", () => {
  for (const model of [
    "805D3",
    "805D4/MR (ペア)",
    "805D4/B (ペア)",
    "805D4 MR (ペア)",
    "805S",
    "805S MR",
    "805 Diamond B",
    "805D3 (805Diamond ローズナット)",
    "805D4+FS805D4（ペア）",
    "805D4 SIGNATURE with Stand",
    "805 D4 Signature カリフォルニアバール・グロス",
  ]) {
    const actual = facts(model);
    assert.equal(actual.length, 1, model);
    assert.equal(actual[0].value, "bookshelf");
    assert.ok(actual[0].source.startsWith("verified_model:https://www.bowerswilkins.com/"));
  }
  const product = normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "B&W",
      model: "805D4/MR (ペア)",
      title: "B&W 805D4/MR (ペア)",
      rawCategory: "スピーカー",
    }),
  );
  assert.ok(product.facetFacts.some((f) => f.value === "bookshelf"));
  assert.equal(product.rawModel, "805D4/MR (ペア)");
});

test("unverified revisions, other brands, components and compatible stands acquire no form fact", () => {
  for (const model of [
    "FS805D3/B",
    "N805ST",
    "805D4SE",
    "805D4 Mk2",
    "1805D4",
    "805D4 + 802D4",
    "805D4用スタンド",
    "805D4 交換ユニット",
    "805 D4 Signature2",
  ])
    assert.deepEqual(facts(model), [], model);
  assert.deepEqual(facts("805D4", { manufacturerId: "other-brand" }), []);
  assert.deepEqual(facts("805D4", { primaryCategoryId: "ACC.STAND" }), []);
  assert.deepEqual(facts("805D4", { title: "B&W 805D4専用スタンド" }), []);
});
