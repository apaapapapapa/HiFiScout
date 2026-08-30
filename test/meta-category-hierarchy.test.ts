import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { canonicalCategoryDefinitions, getCategory } from "../src/catalog/categories.js";
import {
  categoryHierarchyDepth,
  compareCategoryHierarchy,
  normalizeManufacturerFacets,
  normalizeManufacturerFacetValues,
} from "../src/http/meta.js";

test("metadata category ordering keeps every product type immediately after its v3 root", () => {
  const ids = canonicalCategoryDefinitions()
    .filter((category) => category.filterable)
    .sort(compareCategoryHierarchy)
    .map((category) => category.id);

  const cableIndex = ids.indexOf("CAB");
  assert.notEqual(cableIndex, -1);
  assert.deepEqual(ids.slice(cableIndex, cableIndex + 8), [
    "CAB",
    "CAB.ANALOG",
    "CAB.DIGITAL",
    "CAB.SPEAKER",
    "CAB.PERSONAL",
    "CAB.DATA",
    "CAB.ADAPTER",
    "PWR",
  ]);
});

test("metadata indentation depth follows the complete category ancestry", () => {
  const cable = getCategory("CAB");
  const analog = getCategory("CAB.ANALOG");
  assert.ok(cable);
  assert.ok(analog);

  assert.equal(categoryHierarchyDepth(cable), 0);
  assert.equal(categoryHierarchyDepth(analog), 1);
});

test("manufacturer facet normalization merges aliases and sums their active counts", () => {
  const rows = [
    { value: "LUXMAN", active_product_count: 2 },
    { value: "【展示処分品】LUXMAN", active_product_count: 3 },
    { value: "TAD", active_product_count: 1 },
  ];

  assert.deepEqual(normalizeManufacturerFacets(rows), [
    { name: "LUXMAN", activeProductCount: 5 },
    { name: "TAD", activeProductCount: 1 },
  ]);
  assert.deepEqual(normalizeManufacturerFacetValues(rows), ["LUXMAN", "TAD"]);
});
