import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { isProductSearchItem } from "../frontend/api-client.js";
import {
  favoriteMatchesFilters,
  favoriteShopMatch,
  favoriteResults,
  favoriteSnapshot,
  favoriteStoragePayload,
  migrateListingFavorite,
  parseFavoriteStorage,
  sortFavorites,
} from "../frontend/favorites.js";
import type { FavoriteProduct } from "../frontend/favorites.js";
import { changeFavoriteStorage, readFavorites } from "../frontend/favorite-storage.js";
import type { ProductFilters } from "../frontend/filters.js";
import type { DisplayOffer, DisplayProduct } from "../frontend/types.js";

const NOW = Date.parse("2026-08-12T00:00:00.000Z");

function offer(overrides: Partial<DisplayOffer> = {}): DisplayOffer {
  return {
    listing_product_id: 1,
    shop_key: "hifido",
    source_url: "https://example.test/p1",
    title: "TAD ME1TX",
    presentation_color: "",
    condition_text: "中古",
    price_yen: 1_000_000,
    previous_price_yen: null,
    stock_status: "in_stock",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    last_activity_at: "2026-08-11T00:00:00.000Z",
    source_published_at: null,
    ...overrides,
  };
}

function product(overrides: Partial<DisplayProduct> = {}): DisplayProduct {
  return {
    key: "c-1",
    identity_kind: "catalog",
    catalog_product_id: 1,
    manufacturer: "TAD",
    manufacturer_id: "tad",
    model: "ME1TX",
    primary_category_id: "speaker_bookshelf",
    category: "ブックシェルフスピーカー",
    offer_count: 1,
    in_stock_offer_count: 1,
    sold_out_offer_count: 0,
    shop_count: 1,
    lowest_price_yen: 1_000_000,
    highest_price_yen: 1_000_000,
    latest_activity_at: "2026-08-11T00:00:00.000Z",
    newest_listed_at: "2026-08-01T00:00:00.000Z",
    has_new_offer: false,
    has_price_drop: false,
    representative_offer: offer(),
    ...overrides,
  };
}

function filters(overrides: Partial<ProductFilters> = {}): ProductFilters {
  return {
    q: "",
    shop: [],
    manufacturer: [],
    category: "",
    minPrice: "",
    maxPrice: "",
    sort: "updated",
    features: [],
    facets: [],
    inStock: false,
    favoritesOnly: true,
    recentOnly: false,
    priceDropped: false,
    ...overrides,
  };
}

test("product favorites round-trip through storage under their entity key", () => {
  const stored = favoriteSnapshot(product({ key: "c-9" }));
  const store = parseFavoriteStorage(JSON.stringify([stored]), isProductSearchItem);

  assert.deepEqual([...store.products.keys()], ["c-9"]);
  assert.deepEqual(favoriteStoragePayload(store), [stored]);
});

test("a seller-listing favorite is migrated into a namespaced product, never into a product id", () => {
  const store = parseFavoriteStorage(
    JSON.stringify([
      {
        id: 7,
        shop_key: "hifido",
        manufacturer: "TAD",
        model: "ME1TX",
        title: "TAD ME1TX ペア",
        price_yen: 900,
        previous_price_yen: 1000,
        stock_status: "in_stock",
        source_url: "https://example.test/legacy",
        first_seen_at: "2026-08-01T00:00:00.000Z",
      },
    ]),
    isProductSearchItem,
  );

  const migrated = store.products.get("legacy-7");
  assert.ok(migrated);
  assert.equal(migrated.identity_kind, "unresolved_listing");
  assert.equal(migrated.catalog_product_id, null);
  assert.equal(migrated.representative_offer?.listing_product_id, 7);
  assert.equal(migrated.representative_offer?.source_url, "https://example.test/legacy");
  assert.equal(migrated.shop_count, 1);
  assert.equal(migrated.has_price_drop, true);
  // The listing id must never be readable as a product key the server could resolve.
  assert.ok(!store.products.has("c-7"));
  assert.ok(!store.products.has("l-7"));
});

test("a listing favorite without a usable id is discarded rather than migrated", () => {
  assert.equal(migrateListingFavorite({ id: "not a number" }), null);
  assert.equal(migrateListingFavorite({ id: -3 }), null);
});

test("a sold-out listing favorite preserves explicit availability through migration", () => {
  const migrated = migrateListingFavorite({ id: 8, stock_status: "sold_out" });

  assert.ok(migrated);
  assert.equal(migrated.in_stock_offer_count, 0);
  assert.equal(migrated.sold_out_offer_count, 1);
});

test("bare listing ids are preserved as unrenderable legacy entries", () => {
  const store = parseFavoriteStorage(JSON.stringify([42, 43]), isProductSearchItem);

  assert.deepEqual([...store.legacyIds], [42, 43]);
  assert.equal(store.products.size, 0);
  assert.deepEqual(favoriteStoragePayload(store), [42, 43]);
});

test("malformed favorite storage yields an empty collection instead of throwing", () => {
  for (const raw of [null, "", "not json", '{"not":"an array"}']) {
    const store = parseFavoriteStorage(raw, isProductSearchItem);
    assert.equal(store.products.size, 0);
    assert.equal(store.legacyIds.size, 0);
  }
});

test("a snapshot keeps exactly the rendered fields and detaches the nested offer", () => {
  const source = product();
  const snapshot = favoriteSnapshot(source);

  assert.equal(Object.keys(snapshot).length, 19);
  assert.ok(isProductSearchItem(snapshot));
  assert.notEqual(snapshot.representative_offer, source.representative_offer);
  assert.deepEqual(snapshot.representative_offer, source.representative_offer);
});

test("favorite selections use OR within each field and AND across fields", () => {
  const item = product();
  const shop = item.representative_offer!.shop_key;
  assert.equal(
    favoriteMatchesFilters(
      item,
      filters({ manufacturer: ["Other", "TAD"], shop: ["missing", shop] }),
      "",
      NOW,
    ),
    true,
  );
  assert.equal(
    favoriteMatchesFilters(item, filters({ manufacturer: ["Other"], shop: [shop] }), "", NOW),
    false,
  );
  assert.equal(
    favoriteMatchesFilters(item, filters({ manufacturer: ["TAD"], shop: ["missing"] }), "", NOW),
    false,
  );
});

test("free-text favorite search covers the same terms as the server entity index", () => {
  assert.equal(favoriteMatchesFilters(product(), filters({ q: "me1tx" }), "", NOW), true);
  assert.equal(favoriteMatchesFilters(product(), filters({ q: "ブックシェルフ" }), "", NOW), true);
  assert.equal(favoriteMatchesFilters(product(), filters({ q: "luxman" }), "", NOW), false);
});

test("category matching accepts the canonical id or a pre-taxonomy display label", () => {
  const legacy = product({ primary_category_id: "", category: "スピーカー" });
  assert.equal(
    favoriteMatchesFilters(product(), filters({ category: "speaker_bookshelf" }), "", NOW),
    true,
  );
  assert.equal(
    favoriteMatchesFilters(legacy, filters({ category: "speaker" }), "スピーカー", NOW),
    true,
  );
  assert.equal(favoriteMatchesFilters(legacy, filters({ category: "speaker" }), "DAC", NOW), false);
});

test("price bounds treat an unpriced product as zero, matching the original comparison", () => {
  const unpriced = product({ lowest_price_yen: null });
  assert.equal(favoriteMatchesFilters(unpriced, filters({ minPrice: "1" }), "", NOW), false);
  assert.equal(favoriteMatchesFilters(unpriced, filters({ maxPrice: "1" }), "", NOW), true);
  assert.equal(favoriteMatchesFilters(product(), filters({ minPrice: "abc" }), "", NOW), true);
});

test("stock, recency and price-drop toggles each narrow the favorites view", () => {
  assert.equal(
    favoriteMatchesFilters(
      product({ in_stock_offer_count: 0 }),
      filters({ inStock: true }),
      "",
      NOW,
    ),
    false,
  );
  assert.equal(favoriteMatchesFilters(product(), filters({ recentOnly: true }), "", NOW), false);
  assert.equal(
    favoriteMatchesFilters(
      product({ newest_listed_at: "2026-08-11T18:00:00.000Z" }),
      filters({ recentOnly: true }),
      "",
      NOW,
    ),
    true,
  );
  assert.equal(favoriteMatchesFilters(product(), filters({ priceDropped: true }), "", NOW), false);
  assert.equal(
    favoriteMatchesFilters(
      product({ has_price_drop: true }),
      filters({ priceDropped: true }),
      "",
      NOW,
    ),
    true,
  );
});

test("the shop filter is evaluated against the snapshot's own offer", () => {
  const stored = product({ representative_offer: offer({ shop_key: "formusic" }) });
  assert.equal(favoriteMatchesFilters(stored, filters({ shop: ["formusic"] }), "", NOW), true);
  assert.equal(favoriteMatchesFilters(stored, filters({ shop: ["hifido"] }), "", NOW), false);
});

test("price sorting pushes unpriced products last in both directions", () => {
  const items = [
    product({ key: "c-1", lowest_price_yen: 300 }),
    product({ key: "c-2", lowest_price_yen: null }),
    product({ key: "c-3", lowest_price_yen: 100 }),
  ];

  assert.deepEqual(
    sortFavorites(items, "priceAsc").map((item) => item.key),
    ["c-3", "c-1", "c-2"],
  );
  assert.deepEqual(
    sortFavorites(items, "priceDesc").map((item) => item.key),
    ["c-1", "c-3", "c-2"],
  );
});

test("the default favorite order is most recent activity first", () => {
  const items = [
    product({ key: "c-1", latest_activity_at: "2026-08-01T00:00:00.000Z" }),
    product({ key: "c-2", latest_activity_at: "2026-08-10T00:00:00.000Z" }),
    product({
      key: "c-3",
      latest_activity_at: null,
      newest_listed_at: "2026-08-05T00:00:00.000Z",
    }),
  ];

  assert.deepEqual(
    sortFavorites(items, "updated").map((item) => item.key),
    ["c-2", "c-3", "c-1"],
  );
});

test("favorite publication order differs from activity order and keeps unknown dates last", () => {
  const items = [
    product({
      key: "recent-price-change",
      newest_listed_at: "2026-09-01",
      latest_activity_at: "2026-09-12",
    }),
    product({
      key: "recent-listing",
      newest_listed_at: "2026-09-11",
      latest_activity_at: "2026-09-11",
    }),
    product({ key: "missing-date", newest_listed_at: null, latest_activity_at: null }),
    product({ key: "invalid-date", newest_listed_at: "invalid", latest_activity_at: null }),
  ];
  const keys = (sort: string) => sortFavorites(items, sort).map((item) => item.key);
  assert.deepEqual(keys("updated"), [
    "recent-price-change",
    "recent-listing",
    "missing-date",
    "invalid-date",
  ]);
  assert.deepEqual(keys("newest"), [
    "recent-listing",
    "recent-price-change",
    "missing-date",
    "invalid-date",
  ]);
  assert.deepEqual(keys("oldest"), [
    "recent-price-change",
    "recent-listing",
    "missing-date",
    "invalid-date",
  ]);
});

test("sorting does not mutate the caller's array", () => {
  const items = [
    product({ key: "c-1", lowest_price_yen: 300 }),
    product({ key: "c-2", lowest_price_yen: 100 }),
  ];
  sortFavorites(items, "priceAsc");
  assert.deepEqual(
    items.map((item) => item.key),
    ["c-1", "c-2"],
  );
});

test("the favorites view filters then sorts", () => {
  const store = {
    products: new Map([
      [
        "c-1",
        product({
          key: "c-1",
          lowest_price_yen: 300,
          representative_offer: offer({ shop_key: "hifido" }),
        }),
      ],
      [
        "c-2",
        product({
          key: "c-2",
          lowest_price_yen: 100,
          representative_offer: offer({ shop_key: "formusic" }),
        }),
      ],
      [
        "c-3",
        product({
          key: "c-3",
          lowest_price_yen: 200,
          representative_offer: offer({ shop_key: "hifido" }),
        }),
      ],
    ]),
    legacyIds: new Set<number>(),
  };

  const results = favoriteResults(store, filters({ shop: ["hifido"], sort: "priceAsc" }), "", NOW);

  assert.deepEqual(
    results.map((item) => item.key),
    ["c-3", "c-1"],
  );
});

test("interleaved tab intents preserve additions and a late refresh cannot resurrect a removal", () => {
  let value: string | null = null;
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
  const first = product({ key: "c-1" });
  const second = product({ key: "c-2" });
  changeFavoriteStorage(storage, { kind: "add", product: first });
  changeFavoriteStorage(storage, { kind: "add", product: second });
  assert.deepEqual([...readFavorites(storage).products.keys()], ["c-1", "c-2"]);
  changeFavoriteStorage(storage, { kind: "remove", key: first.key });
  changeFavoriteStorage(storage, {
    kind: "refresh",
    products: [first, { ...second, lowest_price_yen: 90_000 }],
  });
  const current = readFavorites(storage);
  assert.deepEqual([...current.products.keys()], ["c-2"]);
  assert.equal(current.products.get("c-2")?.lowest_price_yen, 90_000);
  changeFavoriteStorage(storage, { kind: "add", product: first });
  assert.equal(readFavorites(storage).products.size, 2);
});

test("favorite search uses shared token, width, model and manufacturer aliases", () => {
  const tad = product({
    model: "D1000mk2",
    representative_offer: offer({ title: "TAD D1000mk2" }),
  });
  for (const q of ["tad 1000", "ＴＡＤ　１０００", "D-1000 MKII"]) {
    assert.equal(favoriteMatchesFilters(tad, filters({ q }), "", NOW), true, q);
  }
  assert.equal(favoriteMatchesFilters(tad, filters({ q: "tad 1000 missing" }), "", NOW), false);
  const luxman = product({ manufacturer: "LUXMAN", manufacturer_id: "luxman", model: "D-10X" });
  assert.equal(favoriteMatchesFilters(luxman, filters({ q: "ラックスマン D10X" }), "", NOW), true);
});

test("multi-shop favorites retain unknown candidates and filter confirmed offers together", () => {
  const item: FavoriteProduct = product({ offer_count: 2, shop_count: 2 });
  assert.equal(favoriteShopMatch(item, ["second-shop"]), "unknown");
  assert.equal(favoriteMatchesFilters(item, filters({ shop: ["second-shop"] }), "", NOW), true);
  item.favorite_offers = {
    key: item.key,
    checkedAt: new Date(NOW).toISOString(),
    complete: true,
    offers: [
      { id: 1, shopKey: "hifido", priceYen: 100_000, stock: "in_stock" },
      { id: 2, shopKey: "second-shop", priceYen: 200_000, stock: "in_stock" },
    ],
  };
  assert.equal(favoriteShopMatch(item, ["second-shop"]), "match");
  assert.equal(favoriteShopMatch(item, ["absent"]), "missing");
  assert.equal(
    favoriteMatchesFilters(item, filters({ shop: ["second-shop"], maxPrice: "150000" }), "", NOW),
    false,
  );
  assert.equal(
    favoriteMatchesFilters(item, filters({ shop: ["second-shop"], minPrice: "150000" }), "", NOW),
    true,
  );
  const raw = JSON.stringify([item]);
  assert.deepEqual(
    parseFavoriteStorage(raw, isProductSearchItem).products.get(item.key)?.favorite_offers,
    item.favorite_offers,
  );
  item.favorite_offers.key = "c-999";
  assert.equal(
    parseFavoriteStorage(JSON.stringify([item]), isProductSearchItem).products.get(item.key)
      ?.favorite_offers,
    undefined,
  );
});
