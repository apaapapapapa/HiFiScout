import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { searchProducts } from "../src/db/product-search-repository.js";
import { suggestProducts } from "../src/db/product-suggest-repository.js";
import { favoriteMatchesFilters } from "../frontend/favorites.js";
import type { ProductFilters } from "../frontend/filters.js";
import { accountReads } from "../src/db/read-accounting.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { captureDatabase } from "./helpers/d1.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";

async function seed(db: QueryableDatabase): Promise<void> {
  const rows = [
    ["lumin", "LUMIN", "U2", "LUMIN"],
    ["fiio", "FiiO", "M27 Aluminum Alloy", "FiiO"],
    ["hibymusic", "HiBy", "R8 II Aluminum Alloy - Red", "HiBy"],
    ["sonus-faber", "Sonus faber", "Lumina II Amator", "Sonus faber"],
    ["sbooster", "Sbooster", "LUMIN U2 power supply", "Sbooster"],
    ["lumin", "LUMIN", "D3", "LUMIN"],
    ["legacy-lumin", "【中古品】LUMIN", "U2 MINI", "LUMIN"],
    ["luxman", "LUXMAN", "L-507Z", "LUXMAN ラックスマン"],
    ["legacy-luxman", "【中古品】ラックスマン", "L-509Z", "LUXMAN ラックスマン"],
    ["msb", "MSB Technology", "Reference DAC", "MSB Technology"],
    ["tad", "TAD", "D1000MK2", "TAD"],
    ["other", "Other", "D1000MK2 TAD-compatible accessory", "Other"],
  ];
  for (const [index, [manufacturerId, manufacturer, model, terms]] of rows.entries()) {
    const id = index + 1;
    const title = `${manufacturer} ${model}`;
    await db.batch([
      db
        .prepare(`INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,
        first_seen_at,last_seen_at,last_changed_at,last_activity_at,price_yen)
        VALUES (?,'hifido',?, ?,?,'in_stock',?,?,?, ?,?)`)
        .bind(id, String(id), title, `https://example.test/${id}`, AT, AT, AT, AT, id * 100),
      db
        .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,
        manufacturer_id,manufacturer,model,normalized_model,manufacturer_terms,model_terms,title_terms,
        offer_count,in_stock_offer_count,shop_count,lowest_price_yen,lowest_in_stock_price_yen,
        latest_activity_at,newest_listed_at,latest_in_stock_activity_at,newest_in_stock_listed_at)
        VALUES (?,?,'unresolved_listing',?,?,?,?,?,?,?, ?,1,1,1,?,?, ?,?,?,?)`)
        .bind(
          id,
          `l-${id}`,
          id,
          manufacturerId,
          manufacturer,
          model,
          model,
          terms,
          model,
          title,
          id * 100,
          id * 100,
          AT,
          AT,
          AT,
          AT,
        ),
      db
        .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        VALUES (?,?,'hifido')`)
        .bind(id, id),
    ]);
  }
}

test("known manufacturer text excludes substrings and compatibility mentions before counting", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    await seed(db);
    const snapshots = (await searchProducts(db, productQuery("?limit=50"))).items;
    const cases: [string, string[]][] = [
      ["lumin", ["l-1", "l-6", "l-7"]],
      ["LuMiN", ["l-1", "l-6", "l-7"]],
      ["ＬＵＭＩＮ", ["l-1", "l-6", "l-7"]],
      ["lumin U2", ["l-1", "l-7"]],
      ["Lumina", ["l-4"]],
      ["Aluminum", ["l-2", "l-3"]],
      ["luxman", ["l-8", "l-9"]],
      ["ラックスマン", ["l-8", "l-9"]],
      ["MSB Technology", ["l-10"]],
      ["TAD 1000", ["l-11"]],
      ["1000", ["l-11", "l-12"]],
    ];
    for (const [q, expected] of cases) {
      const result = await searchProducts(
        db,
        productQuery(`?q=${encodeURIComponent(q)}&includeTotal=true&inStock=true`),
      );
      assert.deepEqual(result.items.map((item) => item.key).sort(), [...expected].sort(), q);
      assert.equal(result.totalCount, expected.length, q);
      const filters: ProductFilters = {
        q,
        shop: [],
        manufacturer: [],
        category: "",
        minPrice: "",
        maxPrice: "",
        sort: "updated",
        features: [],
        facets: [],
        inStock: true,
        favoritesOnly: true,
        recentOnly: false,
        priceDropped: false,
      };
      assert.deepEqual(
        snapshots
          .filter((item) => favoriteMatchesFilters(item, filters, ""))
          .map((item) => item.key)
          .sort(),
        [...expected].sort(),
        `favorites: ${q}`,
      );
    }
    for (const q of ["lumin", "LuMiN", "ＬＵＭＩＮ", "LUMIN U2"]) {
      const suggestions = await suggestProducts(db, q);
      assert.ok(suggestions.includes("LUMIN U2"), q);
      assert.ok(
        suggestions.every((value) => value === "LUMIN" || value.startsWith("LUMIN ")),
        q,
      );
    }
    assert.ok((await suggestProducts(db, "Lumina")).includes("Sonus faber Lumina II Amator"));
    for (const [manufacturer, count] of [
      ["fiio", 0],
      ["lumin", 3],
    ] as const) {
      const result = await searchProducts(
        db,
        productQuery(`?q=lumin&manufacturer=${manufacturer}&includeTotal=true`),
      );
      assert.equal(result.totalCount, count, "explicit and inferred manufacturers intersect");
    }
  } finally {
    sqlite.close();
  }
});

test("manufacturer text filters before LIMIT and preserves keyset totals and ordering", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    await seed(db);
    let cursor = "";
    for (const [index, key] of ["l-1", "l-6", "l-7"].entries()) {
      const result = await searchProducts(
        db,
        productQuery(
          `?q=lumin&inStock=true&sort=priceAsc&limit=1&includeTotal=true&cursor=${encodeURIComponent(cursor)}`,
        ),
      );
      assert.deepEqual(
        result.items.map((item) => item.key),
        [key],
      );
      assert.equal(result.totalCount, 3);
      assert.equal(result.totalPages, 3);
      assert.equal(result.hasMore, index < 2);
      if (index < 2) assert.ok(result.nextCursor);
      cursor = result.nextCursor ?? "";
    }
  } finally {
    sqlite.close();
  }
});

test("manufacturer text keeps D1 reads scoped to FTS candidates as unrelated entities grow", async () => {
  const { db, dispose } = await database();
  try {
    await seed(db);
    const query = productQuery("?q=lumin&inStock=true&includeTotal=true");
    const captured = captureDatabase();
    await searchProducts(captured, { ...query, includeTotal: false });
    const page = captured.calls.find((call) => /SELECT e\.id, e\.entity_key/.test(call.sql));
    assert.ok(page);
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${page.sql}`)
      .bind(...page.binds)
      .all();
    assert.match(JSON.stringify(plan.results), /product_search_entities_fts VIRTUAL TABLE/);
    assert.doesNotMatch(JSON.stringify(plan.results), /SCAN e(?: USING|["\s])/);
    const measurements: {
      size: number;
      rowsRead: number;
      statements: number;
      suggestReads: number;
    }[] = [];
    let previous = 12;
    for (const size of [100, 1_000, 10_000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (
        SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?
      ) INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,
        first_seen_at,last_seen_at,last_changed_at,last_activity_at)
        SELECT i,'hifido',CAST(i AS TEXT),'Other Amplifier '||i,'https://example.test/'||i,
          'in_stock','${AT}','${AT}','${AT}','${AT}' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`WITH RECURSIVE n(i) AS (
        SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?
      ) INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,
        manufacturer_id,manufacturer,model,manufacturer_terms,model_terms,in_stock_offer_count)
        SELECT i,'l-'||i,'unresolved_listing',i,'other','Other','Amplifier '||i,
          'Other','Amplifier '||i,1 FROM n`)
        .bind(previous + 1, size)
        .run();
      const measured = accountReads(db);
      const result = await searchProducts(measured.db, query);
      assert.equal(result.totalCount, 3);
      assert.equal(result.items.length, 3);
      assert.equal(measured.rowsWritten(), 0);
      assert.equal(measured.countedStatements(), 5);
      const suggestMeasured = accountReads(db);
      const suggestions = await suggestProducts(suggestMeasured.db, "lumin");
      assert.ok(suggestions.includes("LUMIN U2"));
      assert.ok(suggestions.every((value) => value === "LUMIN" || value.startsWith("LUMIN ")));
      assert.equal(suggestMeasured.countedStatements(), 1);
      assert.equal(suggestMeasured.rowsWritten(), 0);
      measurements.push({
        size,
        rowsRead: measured.rowsRead(),
        statements: measured.statementCount(),
        suggestReads: suggestMeasured.rowsRead(),
      });
      previous = size;
    }
    console.log(JSON.stringify({ event: "manufacturer_text_search_read_budget", measurements }));
    assert.ok(
      measurements.every((m) => m.rowsRead < 300),
      JSON.stringify(measurements),
    );
    assert.ok(
      measurements[2].rowsRead <= measurements[0].rowsRead + 30,
      JSON.stringify(measurements),
    );
    assert.ok(
      measurements.every((m) => m.suggestReads < 150),
      JSON.stringify(measurements),
    );
    assert.ok(
      measurements[2].suggestReads <= measurements[0].suggestReads + 30,
      JSON.stringify(measurements),
    );
  } finally {
    await dispose();
  }
}, 60_000);
