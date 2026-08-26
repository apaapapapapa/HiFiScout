import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { canonicalCategoryDefinitions, getCategory } from "../src/catalog/categories.js";
import {
  categoryHierarchyDepth,
  compareCategoryHierarchy,
  normalizeManufacturerFacets,
} from "../src/http/meta.js";

test("metadata category ordering keeps nested cable leaves inside the accessories subtree", () => {
  const ids = canonicalCategoryDefinitions()
    .filter((category) => category.filterable)
    .sort(compareCategoryHierarchy)
    .map((category) => category.id);

  const accessoriesIndex = ids.indexOf("accessories");
  assert.notEqual(accessoriesIndex, -1);
  assert.deepEqual(ids.slice(accessoriesIndex, accessoriesIndex + 15), [
    "accessories",
    "cable",
    "cable_xlr",
    "cable_rca",
    "cable_phono",
    "cable_usb",
    "cable_lan",
    "cable_digital",
    "cable_power",
    "cable_other",
    "rack",
    "power_strip",
    "clean_power",
    "vacuum_tube",
    "other_accessory",
  ]);
});

test("metadata indentation depth follows the complete category ancestry", () => {
  const accessories = getCategory("accessories");
  const cable = getCategory("cable");
  const xlr = getCategory("cable_xlr");
  assert.ok(accessories);
  assert.ok(cable);
  assert.ok(xlr);

  assert.equal(categoryHierarchyDepth(accessories), 0);
  assert.equal(categoryHierarchyDepth(cable), 1);
  assert.equal(categoryHierarchyDepth(xlr), 2);
});

test("manufacturer facet normalization merges aliases and sums their active counts", () => {
  assert.deepEqual(
    normalizeManufacturerFacets([
      { value: "LUXMAN", active_product_count: 2 },
      { value: "【展示処分品】LUXMAN", active_product_count: 3 },
      { value: "TAD", active_product_count: 1 },
    ]),
    [
      { name: "LUXMAN", activeProductCount: 5 },
      { name: "TAD", activeProductCount: 1 },
    ],
  );
});
