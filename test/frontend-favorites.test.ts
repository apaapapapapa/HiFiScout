import test from "node:test";
import assert from "node:assert/strict";

import {
  favoriteMatchesFilters,
  favoriteResults,
  favoriteSnapshot,
  favoriteStoragePayload,
  parseFavoriteStorage,
  sortFavorites,
} from "../frontend/favorites.js";
import type { ProductFilters } from "../frontend/filters.js";
import type { DisplayProduct } from "../frontend/types.js";

const NOW = Date.parse("2026-08-12T00:00:00.000Z");

function product(overrides: Partial<DisplayProduct> = {}): DisplayProduct {
  return {
    id: 1,
    shop_key: "hifido",
    manufacturer: "TAD",
    manufacturer_id: "tad",
    raw_manufacturer: "TAD",
    model: "ME1TX",
    title: "TAD ME1TX",
    category: "スピーカー",
    raw_category: "スピーカー",
    primary_category_id: "speaker",
    condition_text: "中古",
    price_yen: 1_000_000,
    previous_price_yen: null,
    stock_status: "in_stock",
    source_url: "https://example.test/p1",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    last_changed_at: "2026-08-11T00:00:00.000Z",
    last_activity_at: "2026-08-11T00:00:00.000Z",
    search_aliases: "スピーカー speaker",
    category_ids: ["speaker"],
    ...overrides,
  };
}

function filters(overrides: Partial<ProductFilters> = {}): ProductFilters {
  return {
    q: "",
    shop: "",
    manufacturer: "",
    category: "",
    minPrice: "",
    maxPrice: "",
    sort: "newest",
    inStock: false,
    favoritesOnly: true,
    recentOnly: false,
    priceDropped: false,
    ...overrides,
  };
}

test("both favorite storage generations are read, and only snapshots are written back", () => {
  const store = parseFavoriteStorage(JSON.stringify([42, { id: 7, title: "TAD" }]));

  assert.deepEqual([...store.legacyIds], [42]);
  assert.deepEqual([...store.products.keys()], [7]);
  assert.deepEqual(favoriteStoragePayload(store), [42, { id: 7, title: "TAD" }]);
});

test("malformed favorite storage yields an empty collection instead of throwing", () => {
  for (const raw of [null, "", "not json", '{"not":"an array"}']) {
    const store = parseFavoriteStorage(raw);
    assert.equal(store.products.size, 0);
    assert.equal(store.legacyIds.size, 0);
  }
});

test("a snapshot keeps exactly the rendered fields and copies the category array", () => {
  const source = product();
  const snapshot = favoriteSnapshot(source);

  assert.equal(Object.keys(snapshot).length, 21);
  assert.deepEqual(snapshot.category_ids, ["speaker"]);
  snapshot.category_ids.push("amplifier");
  assert.deepEqual(source.category_ids, ["speaker"]);
});

test("free-text favorite search covers the same fields as the server projection", () => {
  assert.equal(favoriteMatchesFilters(product(), filters({ q: "me1tx" }), "", NOW), true);
  assert.equal(favoriteMatchesFilters(product(), filters({ q: "speaker" }), "", NOW), true);
  assert.equal(favoriteMatchesFilters(product(), filters({ q: "luxman" }), "", NOW), false);
});

test("category matching accepts an id, the primary id, or a pre-taxonomy display label", () => {
  const legacy = product({ category_ids: [], primary_category_id: null });
  assert.equal(favoriteMatchesFilters(product(), filters({ category: "speaker" }), "", NOW), true);
  assert.equal(
    favoriteMatchesFilters(legacy, filters({ category: "speaker" }), "スピーカー", NOW),
    true,
  );
  assert.equal(favoriteMatchesFilters(legacy, filters({ category: "speaker" }), "DAC", NOW), false);
});

test("price bounds treat an unpriced listing as zero, matching the original comparison", () => {
  const unpriced = product({ price_yen: null });
  assert.equal(favoriteMatchesFilters(unpriced, filters({ minPrice: "1" }), "", NOW), false);
  assert.equal(favoriteMatchesFilters(unpriced, filters({ maxPrice: "1" }), "", NOW), true);
  assert.equal(favoriteMatchesFilters(product(), filters({ minPrice: "abc" }), "", NOW), true);
});

test("stock, recency and price-drop toggles each narrow the favorites view", () => {
  assert.equal(
    favoriteMatchesFilters(
      product({ stock_status: "sold_out" }),
      filters({ inStock: true }),
      "",
      NOW,
    ),
    false,
  );
  assert.equal(favoriteMatchesFilters(product(), filters({ recentOnly: true }), "", NOW), false);
  assert.equal(
    favoriteMatchesFilters(
      product({ first_seen_at: "2026-08-11T18:00:00.000Z" }),
      filters({ recentOnly: true }),
      "",
      NOW,
    ),
    true,
  );
  assert.equal(favoriteMatchesFilters(product(), filters({ priceDropped: true }), "", NOW), false);
  assert.equal(
    favoriteMatchesFilters(
      product({ price_yen: 900, previous_price_yen: 1000 }),
      filters({ priceDropped: true }),
      "",
      NOW,
    ),
    true,
  );
});

test("price sorting pushes unpriced listings last in both directions", () => {
  const items = [
    product({ id: 1, price_yen: 300 }),
    product({ id: 2, price_yen: null }),
    product({ id: 3, price_yen: 100 }),
  ];

  assert.deepEqual(
    sortFavorites(items, "priceAsc").map((item) => item.id),
    [3, 1, 2],
  );
  assert.deepEqual(
    sortFavorites(items, "priceDesc").map((item) => item.id),
    [1, 3, 2],
  );
});

test("the default favorite order is most recent activity first", () => {
  const items = [
    product({ id: 1, last_activity_at: "2026-08-01T00:00:00.000Z" }),
    product({ id: 2, last_activity_at: "2026-08-10T00:00:00.000Z" }),
    product({ id: 3, last_activity_at: null, first_seen_at: "2026-08-05T00:00:00.000Z" }),
  ];

  assert.deepEqual(
    sortFavorites(items, "newest").map((item) => item.id),
    [2, 3, 1],
  );
});

test("sorting does not mutate the caller's array", () => {
  const items = [product({ id: 1, price_yen: 300 }), product({ id: 2, price_yen: 100 })];
  sortFavorites(items, "priceAsc");
  assert.deepEqual(
    items.map((item) => item.id),
    [1, 2],
  );
});

test("the favorites view filters then sorts", () => {
  const store = {
    products: new Map([
      [1, product({ id: 1, price_yen: 300, shop_key: "hifido" })],
      [2, product({ id: 2, price_yen: 100, shop_key: "formusic" })],
      [3, product({ id: 3, price_yen: 200, shop_key: "hifido" })],
    ]),
    legacyIds: new Set<number>(),
  };

  const results = favoriteResults(store, filters({ shop: "hifido", sort: "priceAsc" }), "", NOW);

  assert.deepEqual(
    results.map((item) => item.id),
    [3, 1],
  );
});
