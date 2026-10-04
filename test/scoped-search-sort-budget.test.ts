import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { searchProducts } from "../src/db/product-search-repository.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";
import { recordingDatabase } from "./helpers/query-plan.js";

test("indexed product filters bound matching-offer sorting as unrelated same-shop inventory grows", async () => {
  const { db, dispose } = await database();
  try {
    const measurements: { size: number; filter: string; rowsRead: number }[] = [];
    let previous = 0;
    for (const size of [100, 1_000, 10_000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (
        SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?
      ) INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,
        first_seen_at,last_seen_at,last_changed_at,last_activity_at,price_yen,previous_price_yen)
        SELECT i,'hifido',CAST(i AS TEXT),'amplifier','https://example.test/'||i,'in_stock',
          '${AT}','${AT}','${AT}','${AT}',100+i,20000 FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,
        manufacturer_id,manufacturer,model,model_terms,offer_count,in_stock_offer_count,shop_count)
        SELECT id,'l-'||id,'unresolved_listing',id,'luxman','LUXMAN',
          CASE WHEN id<=12 THEN 'needle' ELSE 'unrelated' END,
          CASE WHEN id<=12 THEN 'needle' ELSE 'unrelated' END,1,1,1
        FROM products WHERE id>? AND id<>2`)
        .bind(previous)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        SELECT id,CASE WHEN id=2 THEN 1 ELSE id END,shop_key FROM products WHERE id>?`)
        .bind(previous)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entity_categories(entity_id,category_id,is_direct)
        SELECT id,CASE WHEN id<=12 THEN 'AMP.PRE' ELSE 'SPK.BOOK' END,1
        FROM product_search_entities WHERE id>?`)
        .bind(previous)
        .run();
      for (const filter of [
        "q=needle&shop=hifido&inStock=true",
        "category=AMP.PRE&shop=hifido&inStock=true",
        "q=needle&minPrice=100&maxPrice=200&priceDropped=true&inStock=true",
        "q=needle&category=AMP.PRE&manufacturer=luxman&shop=hifido&inStock=true",
      ]) {
        const recorded = recordingDatabase(db);
        const measured = measureD1Cost(recorded.db);
        const query = `?${filter}&sort=priceAsc&includeTotal=true&limit=5`;
        const first = await searchProducts(measured.db, productQuery(query));
        assert.equal(first.totalCount, 11, filter);
        assert.deepEqual(
          first.items.map((item) => item.key),
          ["l-1", "l-3", "l-4", "l-5", "l-6"],
        );
        assert.equal(first.items[0].offer_count, 2);
        assert.equal(first.items[0].lowest_price_yen, 101);
        const second = await searchProducts(
          measured.db,
          productQuery(`${query}&cursor=${encodeURIComponent(first.nextCursor!)}`),
        );
        assert.equal(second.totalCount, 11);
        assert.deepEqual(
          second.items.map((item) => item.key),
          ["l-7", "l-8", "l-9", "l-10", "l-11"],
        );
        const last = await searchProducts(
          measured.db,
          productQuery(`${query}&cursor=${encodeURIComponent(second.nextCursor!)}`),
        );
        assert.equal(last.totalCount, 11);
        assert.deepEqual(
          last.items.map((item) => item.key),
          ["l-12"],
        );
        assert.equal(last.hasMore, false);
        const metrics = measured.metrics();
        assert.equal(metrics.rowsWritten, 0);
        assert.equal(metrics.sqlStatements, 18, "one bounded planning probe per page is included");
        assert.notEqual(metrics.rowsRead, null);
        measurements.push({ size, filter, rowsRead: metrics.rowsRead! });
        if (size === 10_000) {
          const page = recorded.executed.find(
            (statement) =>
              statement.sql.includes("matching_sort") && statement.sql.includes("SELECT e.id"),
          );
          assert.ok(page);
          const plan = await db
            .prepare(`EXPLAIN QUERY PLAN ${page.sql}`)
            .bind(...page.binds)
            .all();
          console.log(
            JSON.stringify({ event: "scoped_search_sort_plan", filter, plan: plan.results }),
          );
        }
      }
      previous = size;
    }
    console.log(JSON.stringify({ event: "scoped_search_sort_read_budget", measurements }));
    for (const filter of new Set(measurements.map((cost) => cost.filter))) {
      const costs = measurements.filter((cost) => cost.filter === filter);
      assert.ok(
        costs.every((cost) => cost.rowsRead < 2_000),
        JSON.stringify(costs),
      );
      assert.ok(costs[2].rowsRead <= costs[0].rowsRead + 100, JSON.stringify(costs));
    }
    // Reverse the selectivity: a broad product selector must not force per-entity offer work
    // across all 10,000 products when the requested shops only hold twelve listings.
    await db
      .prepare(`UPDATE product_search_entities SET model_terms='needle';
      UPDATE product_search_entity_categories SET category_id='AMP.PRE';
      UPDATE products SET shop_key='audiounion' WHERE id>12;
      UPDATE product_search_entity_offers SET shop_key='audiounion' WHERE listing_product_id>12;`)
      .run();
    for (const selector of ["q=needle", "category=AMP.PRE"]) {
      for (const shops of ["shop=hifido", "shop=hifido&shop=missing"]) {
        const measured = measureD1Cost(db);
        const result = await searchProducts(
          measured.db,
          productQuery(
            `?${selector}&${shops}&inStock=true&sort=priceAsc&includeTotal=true&limit=5`,
          ),
        );
        assert.equal(result.totalCount, 11);
        assert.deepEqual(
          result.items.map((item) => item.key),
          ["l-1", "l-3", "l-4", "l-5", "l-6"],
        );
        const metrics = measured.metrics();
        assert.equal(metrics.rowsWritten, 0);
        assert.equal(metrics.sqlStatements, 6);
        assert.notEqual(metrics.rowsRead, null);
        // Includes the fixed 65-row planning probe. The original shape was about 30k/60k rows;
        // blindly starting every aggregate at entities used about 100k/120k rows instead.
        assert.ok(
          metrics.rowsRead! < (selector.startsWith("q=") ? 31_000 : 61_000),
          JSON.stringify(metrics),
        );
        console.log(
          JSON.stringify({ event: "broad_search_small_shop_budget", selector, shops, metrics }),
        );
      }
    }
  } finally {
    await dispose();
  }
}, 60_000);

test("scoped sort preserves same-offer filters, nulls, ties, totals and all cursor directions", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(`INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,
      is_active,first_seen_at,last_seen_at,last_changed_at,last_activity_at,price_yen) VALUES
      (1,'hifido','1','needle','https://example.test/1','in_stock',1,'${AT}','${AT}','${AT}','${AT}',200),
      (2,'audiounion','2','needle','https://example.test/2','in_stock',1,'${AT}','${AT}','${AT}','${AT}',1),
      (3,'hifido','3','needle','https://example.test/3','in_stock',1,'${AT}','${AT}','${AT}','${AT}',200),
      (4,'hifido','4','needle','https://example.test/4','in_stock',1,'${AT}','${AT}','${AT}','${AT}',NULL),
      (5,'hifido','5','needle','https://example.test/5','sold_out',1,'${AT}','${AT}','${AT}','${AT}',100),
      (6,'hifido','6','needle','https://example.test/6','in_stock',0,'${AT}','${AT}','${AT}','${AT}',50),
      (7,'hifido','7','needle','https://example.test/7','in_stock',1,'${AT}','${AT}','${AT}','${AT}',300);
      INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,
        manufacturer_id,manufacturer,model,model_terms)
      SELECT id,'l-'||id,'unresolved_listing',id,'luxman','LUXMAN','needle','needle'
      FROM products WHERE id<>2;
      INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
      SELECT id,CASE WHEN id=2 THEN 1 ELSE id END,shop_key FROM products;
      INSERT INTO product_search_entity_categories(entity_id,category_id,is_direct)
      SELECT id,'AMP.PRE',1 FROM product_search_entities;
      INSERT INTO product_search_entity_categories(entity_id,category_id,is_direct)
      VALUES (1,'AMP.POW',1);`);
    for (const selector of [
      "q=needle",
      "category=AMP",
      "q=needle&category=AMP&manufacturer=luxman",
    ]) {
      const base = `?${selector}&shop=hifido&inStock=true&includeTotal=true`;
      for (const [sort, ids] of [
        ["priceAsc", [1, 3, 7, 4]],
        ["priceDesc", [7, 3, 1, 4]],
        ["updated", [7, 4, 3, 1]],
        ["newest", [7, 4, 3, 1]],
        ["oldest", [1, 3, 4, 7]],
      ] as const) {
        let cursor = "";
        for (const [index, id] of ids.entries()) {
          const result = await searchProducts(
            db,
            productQuery(`${base}&sort=${sort}&limit=1&cursor=${encodeURIComponent(cursor)}`),
          );
          assert.equal(result.totalCount, 4);
          assert.deepEqual(
            result.items.map((item) => item.key),
            [`l-${id}`],
          );
          assert.equal(result.items[0].offer_count, 1);
          if (id === 1) assert.equal(result.items[0].lowest_price_yen, 200);
          assert.equal(result.hasMore, index < ids.length - 1);
          cursor = result.nextCursor ?? "";
        }
      }
      const offset = await searchProducts(
        db,
        productQuery(`${base}&sort=priceAsc&limit=1&offset=2`),
      );
      assert.equal(offset.totalCount, 4);
      assert.deepEqual(
        offset.items.map((item) => item.key),
        ["l-7"],
      );
      const range = await searchProducts(
        db,
        productQuery(`${base}&sort=priceAsc&minPrice=10&maxPrice=250`),
      );
      assert.deepEqual(
        range.items.map((item) => item.key),
        ["l-1", "l-3"],
      );
      const empty = await searchProducts(db, productQuery(`${base}&sort=priceAsc&maxPrice=10`));
      assert.equal(empty.totalCount, 0);
      assert.deepEqual(empty.items, []);
    }
    sqlite.exec(`INSERT INTO product_offer_facts(product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at)
      VALUES (1,'remote_control','seller','present','title','fixture',1,'${AT}'),
        (2,'shop_warranty','seller','present','title','fixture',1,'${AT}'),
        (3,'remote_control','seller','present','title','fixture',1,'${AT}'),
        (3,'shop_warranty','seller','present','title','fixture',1,'${AT}')`);
    const facts = await searchProducts(
      db,
      productQuery(
        "?q=needle&category=AMP&offer=remote_control&offer=shop_warranty&inStock=true&sort=priceAsc&includeTotal=true",
      ),
    );
    assert.equal(facts.totalCount, 1);
    assert.deepEqual(
      facts.items.map((item) => item.key),
      ["l-3"],
    );
  } finally {
    sqlite.close();
  }
});
