import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { CATALOG_SHORTCUTS, applyCatalogShortcut } from "../frontend/catalog-shortcuts.js";
import { parseUrlFilters, productSearchParams } from "../frontend/filters.js";
import { getCategory } from "../src/catalog/categories.js";
import { isFacetValue } from "../src/catalog/types.js";

test("every shortcut uses a current product category and supported specification values", () => {
  assert.equal(
    new Set(CATALOG_SHORTCUTS.map((shortcut) => shortcut.id)).size,
    CATALOG_SHORTCUTS.length,
  );
  for (const shortcut of CATALOG_SHORTCUTS) {
    assert.equal(getCategory(shortcut.category)?.classifiable, true, shortcut.id);
    for (const facet of shortcut.facets)
      assert.equal(isFacetValue(facet.facetId, facet.value), true, shortcut.id);
  }
});

test("a shortcut replaces equipment criteria together and preserves the shopper's constraints", () => {
  const { values, ...state } = parseUrlFilters(
    "?q=Limited&manufacturer=LUXMAN&shop=hifido&minPrice=50000&maxPrice=100000&category=PER.HEADPHONE&feature=dac&facet=acoustic_design:open_back&newOnly=true&sort=priceAsc",
  );
  const filters = { ...values, ...state, favoritesOnly: false };
  const next = applyCatalogShortcut(filters, CATALOG_SHORTCUTS[0]);
  assert.equal(next.q, "Limited");
  assert.equal(next.manufacturer, "LUXMAN");
  assert.equal(next.shop, "hifido");
  assert.equal(next.minPrice, "50000");
  assert.equal(next.maxPrice, "100000");
  assert.equal(next.recentOnly, true);
  assert.equal(next.inStock, true);
  assert.equal(next.sort, "priceAsc");
  assert.deepEqual(next.features, []);
  assert.deepEqual(next.facets, [{ facetId: "form_factor", value: "bookshelf" }]);
  assert.equal(next.category, "SPK.LOUDSPEAKER");
  assert.equal(filters.category, "PER.HEADPHONE");
  assert.deepEqual(filters.features, ["dac"]);
});

test("CD/SACD shortcuts serialize as alternatives within one facet", () => {
  const shortcut = CATALOG_SHORTCUTS.find((entry) => entry.id === "cd-sacd")!;
  const { values, ...state } = parseUrlFilters("");
  const params = productSearchParams(
    applyCatalogShortcut({ ...values, ...state, favoritesOnly: false }, shortcut),
  );
  assert.equal(params.get("category"), "SRC.DISC");
  assert.deepEqual(params.getAll("facet"), ["supported_media:cd", "supported_media:sacd"]);
});
