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

test("headshell is an independent classifiable analog product type", () => {
  const headshell = getCategory("headshell");
  assert.ok(headshell);
  assert.equal(headshell.name, "ヘッドシェル");
  assert.equal(headshell.parentId, "ANA");
  assert.equal(headshell.classifiable, true);
  assert.equal(headshell.filterable, true);
  assert.deepEqual(categoryClosureIds("headshell"), ["ANA.HEADSHELL", "ANA"]);
  assert.ok(categoryFilterIds("headshell").includes("ANA.HEADSHELL"));
  assert.equal(categoryFilterIds("ANA.CARTRIDGE").includes("ANA.HEADSHELL"), false);
  assert.ok(categoryFilterIds("ANA").includes("ANA.HEADSHELL"));
});

test("headshell titles classify more specifically than the cartridge seller bucket", () => {
  assert.deepEqual(inferExplicitCategoryIds("Ortofon LH-4000 Headshell"), ["ANA.HEADSHELL"]);
  assert.deepEqual(inferExplicitCategoryIds("Audio-Technica AT-LH15H ヘッドシェル"), [
    "ANA.HEADSHELL",
  ]);

  const headshell = classify("Audio-Technica AT-LH15H ヘッドシェル", "カートリッジ");
  assert.equal(headshell.primaryCategoryId, "ANA.HEADSHELL");
  assert.deepEqual(headshell.categoryIds, ["ANA.HEADSHELL"]);

  const cartridge = classify("Audio-Technica AT33PTG/II", "カートリッジ");
  assert.equal(cartridge.primaryCategoryId, "ANA.CARTRIDGE");
  assert.deepEqual(cartridge.categoryIds, ["ANA.CARTRIDGE"]);
});
