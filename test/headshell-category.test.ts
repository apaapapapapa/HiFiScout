import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { categoryClosureIds, categoryFilterIds, getCategory } from "../src/catalog/categories.js";
import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { parsedProduct } from "./helpers/fixtures.js";

function classify(title: string, rawCategory = "") {
  return normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "",
      rawManufacturer: "",
      title,
      category: "",
      rawCategory,
    }),
  );
}

test("headshell is a classifiable child of cartridge", () => {
  const headshell = getCategory("headshell");
  assert.ok(headshell);
  assert.equal(headshell.name, "ヘッドシェル");
  assert.equal(headshell.parentId, "cartridge");
  assert.equal(headshell.classifiable, true);
  assert.equal(headshell.filterable, true);
  assert.deepEqual(categoryClosureIds("headshell"), ["headshell", "cartridge", "analog"]);
  assert.deepEqual(categoryFilterIds("headshell"), ["headshell"]);
  assert.ok(categoryFilterIds("cartridge").includes("headshell"));
  assert.ok(categoryFilterIds("analog").includes("headshell"));
});

test("headshell titles classify more specifically than the cartridge seller bucket", () => {
  assert.deepEqual(inferExplicitCategoryIds("Ortofon LH-4000 Headshell"), ["headshell"]);
  assert.deepEqual(inferExplicitCategoryIds("Audio-Technica AT-LH15H ヘッドシェル"), ["headshell"]);

  const headshell = classify("Audio-Technica AT-LH15H ヘッドシェル", "カートリッジ");
  assert.equal(headshell.primaryCategoryId, "headshell");
  assert.deepEqual(headshell.categoryIds, ["headshell"]);

  const cartridge = classify("Audio-Technica AT33PTG/II", "カートリッジ");
  assert.equal(cartridge.primaryCategoryId, "cartridge");
  assert.deepEqual(cartridge.categoryIds, ["cartridge"]);
});
