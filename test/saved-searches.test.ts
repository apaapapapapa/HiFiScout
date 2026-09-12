import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  MAX_SAVED_SEARCHES,
  parseSavedSearches,
  savedSearchFilters,
  savedSearchName,
  savedSearchQuery,
} from "../frontend/saved-searches.js";
import { savedSearchFeedPath } from "../frontend/filters.js";
import { sanitizedCatalogSearch } from "../frontend/catalog-url-sanitizer.js";

const entry = {
  id: "search-1",
  name: "アンプ候補",
  query: "q=amp&sort=oldest&offer=remote_control&offer=shop_warranty&inStock=false",
  updatedAt: "2026-09-07T00:00:00Z",
};

test("saved searches round-trip repeated conditions and sorting into search and Atom", () => {
  const filters = savedSearchFilters(entry.query);
  filters.shop = ["shop-b", "shop-a"];
  filters.manufacturer = ["LUXMAN", "Accuphase"];
  const query = savedSearchQuery(filters)!;
  const stored = parseSavedSearches(JSON.stringify([{ ...entry, query }]));
  assert.equal(stored.length, 1);
  const restored = savedSearchFilters(stored[0].query);
  assert.deepEqual(restored.shop, ["shop-a", "shop-b"]);
  assert.deepEqual(restored.manufacturer, ["Accuphase", "LUXMAN"]);
  assert.deepEqual(restored.offerFacts, ["remote_control", "shop_warranty"]);
  assert.equal(restored.inStock, false);
  assert.equal(restored.favoritesOnly, false);
  assert.equal(restored.sort, "oldest");
  const feed = savedSearchFeedPath(restored);
  assert.match(feed, /offer=remote_control&offer=shop_warranty/);
  assert.doesNotMatch(feed, /sort=|limit=|compare=|favoritesOnly=/);
  assert.equal(sanitizedCatalogSearch("sort=dealScore"), "sort=dealScore");
});

test("saved explicit activity sorts survive the change of the public default", () => {
  const query = "q=amp&sort=updated&offer=remote_control&inStock=false";
  const stored = parseSavedSearches(JSON.stringify([{ ...entry, query }]));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].query, query);
  const restored = savedSearchFilters(stored[0].query);
  assert.equal(restored.sort, "updated");
  assert.equal(restored.q, "amp");
  assert.deepEqual(restored.offerFacts, ["remote_control"]);
  assert.equal(restored.inStock, false);
  assert.equal(savedSearchQuery(restored), "q=amp&offer=remote_control&inStock=false");
});

test("invalid local search data is rejected instead of silently widening its filters", () => {
  for (const raw of [
    "{",
    "null",
    "{}",
    JSON.stringify(Array(MAX_SAVED_SEARCHES + 1).fill(entry)),
    JSON.stringify([{ ...entry, query: "q=amp&unknown=1" }]),
    JSON.stringify([{ ...entry, query: "minPrice=500&maxPrice=100" }]),
    JSON.stringify([{ ...entry, query: "manufacturer=" + "a".repeat(101) }]),
    JSON.stringify([{ ...entry, id: "../evil" }]),
    JSON.stringify([{ ...entry, updatedAt: "invalid" }]),
  ])
    assert.deepEqual(parseSavedSearches(raw), []);
  assert.equal(parseSavedSearches(JSON.stringify([entry, entry])).length, 1);
  const invalid = { ...savedSearchFilters(""), q: "a".repeat(101) };
  assert.equal(savedSearchQuery(invalid), null);
  assert.equal(savedSearchName(" "), null);
  assert.equal(savedSearchName("あ".repeat(81)), null);
  assert.equal(savedSearchName(" アンプ "), "アンプ");
});
