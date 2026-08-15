import test from "node:test";
import assert from "node:assert/strict";

import { categoryClosureIds } from "../src/catalog/categories.js";
import { syncInventoryRecheckSearchEntities } from "../src/crawler/dispatch.js";
import { decodeCursor } from "../src/db/product-search-cursor.js";
import { toProductSearchItem } from "../src/db/product-search-entity-mapper.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { normalizeManufacturerFacetValues } from "../src/http/meta.js";
import { favoriteMatchesFilters, favoriteSnapshot } from "../frontend/favorites.js";
import type { ProductFilters } from "../frontend/filters.js";
import { asQueryableDatabase, captureDatabase } from "./helpers/d1.js";
import { entityRow } from "./helpers/product-search.js";
import { productQuery } from "./helpers/product-query.js";

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

test("offer-filtered price sort orders by the same matching offers shown on the card", async () => {
  const db = captureDatabase((statement) =>
    /SELECT e\.id, e\.entity_key/.test(statement.sql)
      ? [
          { ...entityRow({ id: 2 }), request_sort_value: 350_000 },
          { ...entityRow({ id: 1 }), request_sort_value: 400_000 },
        ]
      : [],
  );

  const result = await searchProducts(
    db,
    productQuery("?shop=hifido&inStock=true&sort=priceAsc&limit=1"),
  );
  const page = db.calls.find((statement) => /SELECT e\.id, e\.entity_key/.test(statement.sql));
  assert.ok(page);
  assert.match(page.sql, /\) matching_sort ON matching_sort\.entity_id = e\.id/);
  assert.match(page.sql, /p\.shop_key = \?/);
  assert.match(page.sql, /p\.stock_status = 'in_stock'/);
  assert.match(
    page.sql,
    /ORDER BY matching_sort\.lowest_in_stock_price_yen ASC NULLS LAST, e\.id ASC/,
  );
  assert.equal(page.binds.filter((value) => value === "hifido").length, 2);

  assert.ok(result.nextCursor);
  const cursor = decodeCursor(result.nextCursor);
  assert.ok(cursor);
  assert.match(cursor.sort, /priceAsc:inStock\|offers:/);
  assert.equal(cursor.value, 350_000);
});

test("product favorites retain category ancestors so group filters match like server search", () => {
  const product = toProductSearchItem(entityRow({ primary_category_id: "speaker_bookshelf" }));
  const closure = categoryClosureIds("speaker_bookshelf");
  const parent = closure.find((categoryId) => categoryId !== "speaker_bookshelf");
  assert.ok(parent);
  assert.deepEqual(product.category_ids, closure);

  const snapshot = favoriteSnapshot(product);
  assert.deepEqual(snapshot.category_ids, closure);
  assert.equal(
    favoriteMatchesFilters(snapshot, filters({ category: parent }), "", Date.now()),
    true,
  );
});

test("product search cards hide seller condition badges from manufacturer presentation", () => {
  const used = toProductSearchItem(
    entityRow({ manufacturer_id: "luxman", manufacturer: "〖中古品〗LUXMAN" }),
  );
  assert.equal(used.manufacturer, "LUXMAN");
  assert.equal(used.manufacturer_id, "luxman");

  const display = toProductSearchItem(
    entityRow({ manufacturer_id: "luxman", manufacturer: "【展示処分品】LUXMAN" }),
  );
  assert.equal(display.manufacturer, "LUXMAN");
  assert.equal(display.manufacturer_id, "luxman");

  const unknown = toProductSearchItem(
    entityRow({ manufacturer_id: "example-audio", manufacturer: "【中古品】Example Audio" }),
  );
  assert.equal(unknown.manufacturer, "Example Audio");
  assert.equal(unknown.manufacturer_id, "example-audio");
});

test("manufacturer filter vocabulary canonicalizes and deduplicates stale presentations", () => {
  assert.deepEqual(
    normalizeManufacturerFacetValues([
      { value: "〖中古品〗LUXMAN" },
      { value: "【展示処分品】LUXMAN" },
      { value: "LUXMAN" },
      { value: "【中古品】MSB" },
      { value: "MSB Technology" },
    ]),
    ["LUXMAN", "MSB Technology"],
  );
});

test("canonical manufacturer filters also accept stale resolver ids while replay drains", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?manufacturer=MSB%20Technology"));

  const page = db.calls.find((statement) => /SELECT e\.id, e\.entity_key/.test(statement.sql));
  assert.ok(page);
  assert.match(page.sql, /e\.manufacturer_id IN \(\?,\?,\?\)/);
  assert.ok(page.binds.includes("msb-technology"));
  assert.ok(page.binds.includes("msbtechnology"));
  assert.ok(page.binds.includes("msb"));
  assert.ok(page.binds.includes("MSB Technology"));
});

test("a completed inventory recheck refreshes the changed listing's search entity", async () => {
  const calls: unknown[][] = [];
  await syncInventoryRecheckSearchEntities(
    asQueryableDatabase({}),
    "audiounion",
    { status: "checked", outcome: "in_stock", sourceId: "223257", productId: 7 },
    async (_db, shopKey, sourceIds) => {
      calls.push([shopKey, sourceIds]);
      return { listing_count: 1, entity_count: 1, removed_entity_count: 0 };
    },
  );

  assert.deepEqual(calls, [["audiounion", ["223257"]]]);
});

test("a deferred inventory recheck does not rewrite an unchanged search entity", async () => {
  let syncCount = 0;
  await syncInventoryRecheckSearchEntities(
    asQueryableDatabase({}),
    "audiounion",
    { status: "deferred", reason: "upstream_http_429", sourceId: "223257", productId: 7 },
    async () => {
      syncCount += 1;
      return { listing_count: 1, entity_count: 1, removed_entity_count: 0 };
    },
  );

  assert.equal(syncCount, 0);
});
