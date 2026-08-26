import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { detectListingComponents, directCategoryIds } from "../src/catalog/listing-components.js";

function models(rawModel: string, manufacturerId = "esoteric"): string[] {
  return detectListingComponents({ rawModel }, { manufacturerId }).components.map(
    (component) => component.model,
  );
}

function isBundle(rawModel: string, manufacturerId = "esoteric"): boolean {
  return detectListingComponents({ rawModel }, { manufacturerId }).isBundle;
}

test("a set of two products is read as two components", () => {
  const detection = detectListingComponents(
    { rawModel: "Grandioso P1 + Grandioso D1" },
    { manufacturerId: "esoteric" },
  );

  assert.equal(detection.isBundle, true);
  assert.deepEqual(
    detection.components.map((component) => component.model),
    ["Grandioso P1", "Grandioso D1"],
  );
});

test("a three-product set keeps every distinct component", () => {
  assert.deepEqual(models("SX-8000mk2 + RY-5500mk2 + BA-600", "micro"), [
    "SX-8000mk2",
    "RY-5500mk2",
    "BA-600",
  ]);
});

test("a separator inside a real model number is not a boundary", () => {
  // `+` belongs to the model here, so splitting leaves nothing on the other side to resolve.
  // The listing keeps whatever the single-product pipeline made of it; no components are reported.
  assert.equal(isBundle("TELOS2500+", "mund"), false);
  assert.deepEqual(models("TELOS2500+", "mund"), []);
});

test("a single product with several functions is one product", () => {
  // Functions are feature facts. A product that mentions a second category is not a second product.
  assert.equal(isBundle("DAC搭載プリメインアンプ L-507uXII", "luxman"), false);
  assert.equal(isBundle("K-01XD / DAC", "esoteric"), false);
});

test("an accessory mention never becomes a component", () => {
  assert.equal(isBundle("Grandioso P1 + 元箱付き"), false);
  assert.equal(isBundle("Grandioso P1 ・ ケーブル付き"), false);
  assert.equal(isBundle("Grandioso P1 + リモコン"), false);
  assert.deepEqual(models("Grandioso P1 + 元箱付き"), []);
});

test("the same model written twice is one product", () => {
  assert.equal(isBundle("Grandioso P1 + Grandioso P1"), false);
});

test("a listing with no usable model evidence yields no components", () => {
  assert.deepEqual(detectListingComponents({ rawModel: "   " }).components, []);
  assert.equal(detectListingComponents({}).isBundle, false);
});

test("components are reported only for a set, never for a lone product", () => {
  // A single product's model and category already come from the single-product pipeline. Answering
  // the same question twice is how `Grandioso P1 + 元箱付き` became `Grandioso P1 +`.
  assert.deepEqual(models("Grandioso P1"), []);
  assert.deepEqual(models("Grandioso P1 + Grandioso D1").length, 2);
});

test("direct categories are de-duplicated and ordered by the canonical taxonomy", () => {
  // Two components in one category contribute that category once.
  assert.deepEqual(directCategoryIds(["dac", "dac"]), ["dac"]);

  // Order follows the taxonomy, not the order the components were parsed in.
  const forward = directCategoryIds(["transport", "dac"]);
  const reversed = directCategoryIds(["dac", "transport"]);
  assert.deepEqual(forward, reversed);
  assert.equal(forward.length, 2);
});

test("unclassified survives only while nothing is known", () => {
  assert.deepEqual(directCategoryIds(["unclassified", "dac"]), ["dac"]);
  assert.deepEqual(directCategoryIds(["unclassified", "unclassified"]), ["unclassified"]);
  assert.deepEqual(directCategoryIds([]), []);
});

test("values outside the taxonomy are not category membership", () => {
  assert.deepEqual(directCategoryIds(["not_a_category", "dac"]), ["dac"]);
});
