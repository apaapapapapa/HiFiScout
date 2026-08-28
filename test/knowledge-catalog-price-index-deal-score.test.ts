import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { PRODUCT_QUERY_SORTS } from "../src/api/contracts.js";
import {
  addCursorPredicate,
  cursorFor,
  decodeCursor,
  sortDefinition,
  sortOrderBy,
} from "../src/db/product-search-cursor.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { entityRow } from "./helpers/product-search.js";
import { productQuery } from "./helpers/product-query.js";

function dealScore(sqlite: ReturnType<typeof migratedSqlite>["sqlite"], entityKey = "c-101") {
  return sqlite
    .prepare("SELECT deal_score FROM product_search_entities WHERE entity_key = ?")
    .get(entityKey)?.deal_score as number | null | undefined;
}

test("0063 migration persists and incrementally refreshes catalog deal scores", () => {
  const { sqlite } = migratedSqlite();
  sqlite.exec(`
    INSERT INTO knowledge_catalog_products(
      id, manufacturer_id, canonical_model, normalized_model, canonical_name,
      created_at, updated_at
    ) VALUES (
      101, 'tad', 'D1000', 'd1000', 'TAD D1000',
      '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z'
    );

    INSERT INTO product_search_entities(
      entity_key, entity_kind, catalog_product_id, fallback_listing_id,
      lowest_price_yen, lowest_in_stock_price_yen
    ) VALUES ('c-101', 'catalog', 101, NULL, 70000, 80000);
  `);

  assert.equal(dealScore(sqlite), null, "no retained index means no score");

  sqlite.exec(`
    INSERT INTO knowledge_catalog_price_indexes(
      catalog_product_id, asking_sample_count, asking_median_yen,
      asking_min_yen, asking_max_yen, last_computed_at
    ) VALUES (101, 4, 100000, 90000, 120000, '2026-08-28T00:00:00.000Z');
  `);
  assert.equal(dealScore(sqlite), -2000, "cheapest in-stock offer is 20% below median");

  sqlite.exec(`
    UPDATE product_search_entities
    SET lowest_in_stock_price_yen = 90000
    WHERE entity_key = 'c-101';
  `);
  assert.equal(dealScore(sqlite), -1000, "entity price projection refreshes the score");

  sqlite.exec(`
    UPDATE knowledge_catalog_price_indexes
    SET asking_sample_count = 2
    WHERE catalog_product_id = 101;
  `);
  assert.equal(dealScore(sqlite), null, "below the named rollout threshold stays unranked");

  sqlite.exec(`
    UPDATE knowledge_catalog_price_indexes
    SET asking_sample_count = 4, asking_median_yen = 120000
    WHERE catalog_product_id = 101;
  `);
  assert.equal(dealScore(sqlite), -2500, "index changes refresh the denominator");

  sqlite.exec(`
    UPDATE product_search_entities
    SET lowest_in_stock_price_yen = NULL, lowest_price_yen = 72000
    WHERE entity_key = 'c-101';
  `);
  assert.equal(
    dealScore(sqlite),
    -4000,
    "active-price fallback is used when no in-stock price exists",
  );

  sqlite.exec("DELETE FROM knowledge_catalog_price_indexes WHERE catalog_product_id = 101");
  assert.equal(dealScore(sqlite), null, "removing the index clears the denormalized score");
});

test("dealScore sort is ascending, NULL-last, and round-trips through a stable cursor", () => {
  assert.ok(PRODUCT_QUERY_SORTS.includes("dealScore"));
  const sort = sortDefinition("dealScore", true);
  assert.equal(sort.key, "dealScore");
  assert.equal(sort.column, "deal_score");
  assert.equal(sort.direction, "ASC");
  assert.equal(sort.idDirection, "ASC");
  assert.equal(sortOrderBy(sort), "e.deal_score ASC NULLS LAST, e.id ASC");

  const encoded = cursorFor(entityRow({ id: 42 }), sort, -1800);
  const cursor = decodeCursor(encoded);
  assert.deepEqual(cursor, {
    sort: "dealScore",
    id: 42,
    value: -1800,
    isNull: false,
  });

  const where: string[] = [];
  const binds: unknown[] = [];
  addCursorPredicate(where, binds, sort, cursor);
  assert.deepEqual(where, [
    "(e.deal_score IS NULL OR e.deal_score > ? OR (e.deal_score = ? AND e.id > ?))",
  ]);
  assert.deepEqual(binds, [-1800, -1800, 42]);

  const nullCursor = decodeCursor(cursorFor(entityRow({ id: 99 }), sort, null));
  const nullWhere: string[] = [];
  const nullBinds: unknown[] = [];
  addCursorPredicate(nullWhere, nullBinds, sort, nullCursor);
  assert.deepEqual(nullWhere, ["(e.deal_score IS NULL AND e.id > ?)"]);
  assert.deepEqual(nullBinds, [99]);
});

test("dealScore search keeps the persisted ordering even with offer filters", async () => {
  const first = { ...entityRow({ id: 10, entity_key: "c-10" }), request_sort_value: -2200 };
  const second = { ...entityRow({ id: 11, entity_key: "c-11" }), request_sort_value: null };
  const db = captureDatabase((statement) => {
    if (/SELECT e\.id, e\.entity_key/.test(statement.sql)) return [first, second];
    return [];
  });

  const response = await searchProducts(db, productQuery("?sort=dealScore&inStock=true&limit=1"));
  assert.equal(response.items.length, 1);
  assert.equal(response.hasMore, true);
  assert.deepEqual(decodeCursor(response.nextCursor), {
    sort: "dealScore",
    id: 10,
    value: -2200,
    isNull: false,
  });

  const pageCall = db.calls.find((statement) => /SELECT e\.id, e\.entity_key/.test(statement.sql));
  assert.ok(pageCall);
  assert.match(pageCall.sql, /e\.deal_score AS request_sort_value/);
  assert.match(pageCall.sql, /ORDER BY e\.deal_score ASC NULLS LAST, e\.id ASC/);
  assert.doesNotMatch(pageCall.sql, /matching_sort\.deal_score/);
});
