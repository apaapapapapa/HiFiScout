import test from "node:test";
import assert from "node:assert/strict";

import { canonicalCategoryDefinitions, getCategory } from "../src/catalog/categories.js";
import { categoryHierarchyDepth, compareCategoryHierarchy } from "../src/http/meta.js";

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
