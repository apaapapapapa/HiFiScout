import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { activeFilterEntries, filterUrlParams, productSearchParams, savedSearchFeedPath } from "../frontend/filters.js";
import { sanitizedCatalogSearch } from "../frontend/catalog-url-sanitizer.js";
import { normalizedProductFilters, clearedDetailFilters, filterRelaxations } from "../frontend/public-ui-state.js";
import { specificationErrors, specificationFromFilterId } from "../frontend/specification-filters.js";
import { savedSearchFilters, savedSearchQuery, parseSavedSearches } from "../frontend/saved-searches.js";

test("detailed specifications round-trip normalized units through URL, API, saved search and Atom", () => {
  const raw = { ...savedSearchFilters("category=AMP.PRE"), specificationFilters: {
    maxWidthMm: "４５０.０００", maxWeightKg: "12.500", minXlrOutputs: "03",
  } };
  const filters = normalizedProductFilters(raw)!;
  assert.deepEqual(filters.specificationFilters, { maxWidthMm: "450", maxWeightKg: "12.5", minXlrOutputs: "3" });
  const query = filterUrlParams(filters, "list").toString();
  assert.equal(sanitizedCatalogSearch(query), query);
  assert.equal(savedSearchQuery(filters), query);
  assert.deepEqual(savedSearchFilters(query).specificationFilters, filters.specificationFilters);
  for (const params of [productSearchParams(filters), new URL(savedSearchFeedPath(filters), "https://example.test").searchParams]) {
    assert.equal(params.get("maxWidthMm"), "450");
    assert.equal(params.get("minXlrOutputs"), "3");
  }
  const chips = activeFilterEntries(filters, { shop: "", category: "アンプ" });
  assert.ok(chips.some((entry) => entry.id === "spec:maxWeightKg" && entry.label.includes("12.5kg")));
  assert.equal(specificationFromFilterId("spec:maxWeightKg"), "maxWeightKg");
  assert.equal(specificationFromFilterId("spec:invented"), null);
  assert.deepEqual(clearedDetailFilters(filters).specificationFilters, {});
  assert.deepEqual(filterRelaxations(filters).find((entry) => entry.id === "specifications")?.filters.specificationFilters, {});
  assert.ok(!activeFilterEntries({ ...filters, favoritesOnly: true }, { shop: "", category: "" }).some((entry) => entry.id.startsWith("spec:")));
});

test("invalid drafts cannot silently broaden a saved or applied specification search", () => {
  for (const value of ["0", "-1", "NaN", "100001", "1e2", "1.0001"]) {
    const filters = { ...savedSearchFilters(""), specificationFilters: { maxWidthMm: value } };
    assert.ok(specificationErrors(filters.specificationFilters).maxWidthMm);
    assert.equal(normalizedProductFilters(filters), null);
    assert.equal(savedSearchQuery(filters), null);
    assert.equal(productSearchParams(filters).get("maxWidthMm"), value);
  }
  assert.ok(specificationErrors({ minXlrOutputs: "2.5" }).minXlrOutputs);
  assert.deepEqual(specificationErrors({ maxWidthMm: " " }), {});
  assert.equal(sanitizedCatalogSearch("maxWidthMm=1&maxWidthMm=2"), "");
  assert.deepEqual(parseSavedSearches(JSON.stringify([{ id: "one", name: "Bad", query: "minXlrOutputs=2.5", updatedAt: "2026-09-07T00:00:00Z" }])), []);
});
