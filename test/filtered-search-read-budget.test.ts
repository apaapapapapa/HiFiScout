import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { searchProducts } from "../src/db/product-search-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { productQuery } from "./helpers/product-query.js";
import { type PlanStep, recordingDatabase } from "./helpers/query-plan.js";

test("new in-stock totals use the projected date index as stale inventory grows", async () => {
  const { db, dispose } = await database();
  try {
    const recent = 12;
    const size = 10_000;
    await db
      .prepare(`WITH RECURSIVE n(i) AS (
        SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?
      ) INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,
        first_seen_at,last_seen_at,last_changed_at,last_activity_at,price_yen)
        SELECT i,'hifido',CAST(i AS TEXT),'amplifier','https://example.test/'||i,'in_stock',
          CASE WHEN i<=? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')
               ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') END,
          '${AT}','${AT}','${AT}',100000 FROM n`)
      .bind(size, recent)
      .run();
    await db
      .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,
        offer_count,in_stock_offer_count,shop_count,newest_in_stock_listed_at)
        SELECT id,'l-'||id,'unresolved_listing',id,1,1,1,
          CASE WHEN id<=? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')
               ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') END
        FROM products`)
      .bind(recent)
      .run();
    await db
      .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        SELECT id,id,shop_key FROM products`)
      .run();

    const legacy = accountReads(db);
    const oldCount = await legacy.db
      .prepare(`SELECT COUNT(*) AS total FROM product_search_entities e
        WHERE EXISTS (SELECT 1 FROM product_search_entity_offers m
          JOIN products p ON p.id=m.listing_product_id
          WHERE m.entity_id=e.id AND p.is_active=1 AND p.stock_status='in_stock'
            AND COALESCE(p.source_published_at,p.first_seen_at) >=
              strftime('%Y-%m-%dT%H:%M:%fZ','now','-48 hours'))`)
      .all<{ total: number }>();
    assert.equal(oldCount.results?.[0].total, recent);

    const recorded = recordingDatabase(db);
    const measured = accountReads(recorded.db);
    const result = await searchProducts(
      measured.db,
      productQuery("?inStock=true&newOnly=true&includeTotal=true&limit=5"),
    );
    assert.equal(result.totalCount, recent);
    assert.equal(result.items.length, 5);
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(measured.rowsRead() < 500, String(measured.rowsRead()));
    assert.ok(measured.rowsRead() < legacy.rowsRead() / 20);
    console.log(
      JSON.stringify({
        event: "new_in_stock_total_read_budget",
        inventorySize: size,
        recent,
        legacyRowsRead: legacy.rowsRead(),
        rowsRead: measured.rowsRead(),
      }),
    );
    const count = recorded.executed.find((statement) =>
      statement.sql.includes("COUNT(*) AS total"),
    );
    assert.ok(count);
    assert.match(count.sql, /newest_in_stock_listed_at/);
    assert.doesNotMatch(count.sql, /EXISTS/);
  } finally {
    await dispose();
  }
}, 60_000);

test("price-drop totals use the existing active-price index before entity membership", async () => {
  const { db, dispose } = await database();
  try {
    const discounted = 12;
    const size = 10_000;
    await db
      .prepare(`WITH RECURSIVE n(i) AS (
        SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?
      ) INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,
        first_seen_at,last_seen_at,last_changed_at,last_activity_at,price_yen,previous_price_yen)
        SELECT i,'hifido',CAST(i AS TEXT),'amplifier','https://example.test/'||i,'in_stock',
          '${AT}','${AT}','${AT}','${AT}',CASE WHEN i<=? THEN 100000 ELSE 200000 END,
          CASE WHEN i<=? THEN 120000 ELSE NULL END FROM n`)
      .bind(size, discounted, discounted)
      .run();
    await db
      .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,
        offer_count,in_stock_offer_count,shop_count,lowest_price_yen,lowest_in_stock_price_yen,
        latest_activity_at,newest_listed_at,latest_in_stock_activity_at,newest_in_stock_listed_at,
        has_price_drop)
        SELECT id,'l-'||id,'unresolved_listing',id,1,1,1,price_yen,price_yen,
          '${AT}','${AT}','${AT}','${AT}',CASE WHEN id<=? THEN 1 ELSE 0 END
        FROM products`)
      .bind(discounted)
      .run();
    await db
      .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        SELECT id,id,shop_key FROM products`)
      .run();

    const legacy = accountReads(db);
    const oldCount = await legacy.db
      .prepare(`SELECT COUNT(*) AS total FROM product_search_entities e
        WHERE EXISTS (SELECT 1 FROM product_search_entity_offers m
          JOIN products p ON p.id=m.listing_product_id
          WHERE m.entity_id=e.id AND p.is_active=1 AND p.stock_status='in_stock'
            AND p.previous_price_yen IS NOT NULL AND p.price_yen IS NOT NULL
            AND p.price_yen < p.previous_price_yen AND p.price_yen>=? AND p.price_yen<=?)`)
      .bind(75000, 125000)
      .all<{ total: number }>();
    assert.equal(oldCount.results?.[0].total, discounted);

    const recorded = recordingDatabase(db);
    const measured = accountReads(recorded.db);
    const result = await searchProducts(
      measured.db,
      productQuery(
        "?inStock=true&priceDropped=true&minPrice=75000&maxPrice=125000&sort=priceAsc&includeTotal=true&limit=5",
      ),
    );
    assert.equal(result.totalCount, discounted);
    assert.equal(result.items.length, 5);
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(measured.rowsRead() < 500, String(measured.rowsRead()));

    const count = recorded.executed.find((statement) =>
      statement.sql.includes("COUNT(*) AS total"),
    );
    assert.ok(count);
    const optimizedCount = accountReads(db);
    const optimizedCountResult = await optimizedCount.db
      .prepare(count.sql)
      .bind(...count.binds)
      .all<{ total: number }>();
    assert.equal(optimizedCountResult.results?.[0].total, discounted);
    assert.equal(optimizedCount.rowsWritten(), 0);
    assert.ok(optimizedCount.rowsRead() < 500, String(optimizedCount.rowsRead()));
    assert.ok(optimizedCount.rowsRead() < legacy.rowsRead() / 20);
    assert.match(count.sql, /products p INDEXED BY idx_products_active_price/);
    assert.match(count.sql, /e\.id IN/);
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${count.sql}`)
      .bind(...count.binds)
      .all<PlanStep>();
    assert.ok(
      plan.results?.some((step: PlanStep) =>
        /SEARCH p USING INDEX idx_products_active_price/.test(step.detail),
      ),
      JSON.stringify(plan.results),
    );
    console.log(
      JSON.stringify({
        event: "price_drop_total_read_budget",
        inventorySize: size,
        discounted,
        legacyRowsRead: legacy.rowsRead(),
        rowsRead: optimizedCount.rowsRead(),
        responseRowsRead: measured.rowsRead(),
      }),
    );

    for (const query of [
      "?newOnly=true&priceDropped=true&includeTotal=true&limit=5",
      "?newOnly=true&priceDropped=true&minPrice=0&includeTotal=true&limit=5",
      "?newOnly=true&priceDropped=true&maxPrice=999999999999&includeTotal=true&limit=5",
      "?newOnly=true&priceDropped=true&minPrice=0&maxPrice=999999999999&includeTotal=true&limit=5",
    ]) {
      const unbounded = recordingDatabase(db);
      await searchProducts(unbounded.db, productQuery(query));
      const unboundedSearch = unbounded.executed.filter(
        (statement) =>
          statement.sql.includes("COUNT(*) AS total") || statement.sql.includes("matching_sort"),
      );
      assert.ok(unboundedSearch.length >= 2);
      assert.ok(
        unboundedSearch.every(
          (statement) => !statement.sql.includes("INDEXED BY idx_products_active_price"),
        ),
        query,
      );
    }
  } finally {
    await dispose();
  }
}, 60_000);

test("shop totals and pages stay scoped when other shops grow", async () => {
  const { db, dispose } = await database();
  try {
    const costs: { size: number; filter: string; rowsRead: number; legacyCount: number }[] = [];
    let previous = 0;
    for (const size of [100, 1_000, 10_000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (
        SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?
      ) INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,
        first_seen_at,last_seen_at,last_changed_at,last_activity_at,price_yen)
        SELECT i,CASE WHEN i<=12 THEN 'hifido' ELSE 'audiounion' END,CAST(i AS TEXT),
          'LUXMAN amplifier','https://example.test/'||i,'in_stock','${AT}','${AT}','${AT}','${AT}',100000
        FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,
        manufacturer_id,manufacturer,model,offer_count,in_stock_offer_count,shop_count,
        latest_activity_at,newest_listed_at,latest_in_stock_activity_at,newest_in_stock_listed_at)
        SELECT id,'l-'||id,'unresolved_listing',id,
          CASE WHEN id<=12 THEN 'luxman' ELSE 'other' END,
          CASE WHEN id<=12 THEN 'LUXMAN' ELSE 'Other' END,'amplifier',
          CASE WHEN id=1 THEN 2 ELSE 1 END,CASE WHEN id=1 THEN 2 ELSE 1 END,1,
          '${AT}','${AT}','${AT}','${AT}'
        FROM products WHERE id>? AND id<>2`)
        .bind(previous)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        SELECT id,CASE WHEN id=2 THEN 1 ELSE id END,shop_key FROM products WHERE id>?`)
        .bind(previous)
        .run();
      const legacy = accountReads(db);
      await db
        .prepare(`INSERT INTO product_offer_facts(product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at)
          SELECT products.id, value, 'seller', 'present', 'condition_text', 'fixture', 1, '${AT}'
          FROM products CROSS JOIN json_each('["remote_control","shop_warranty"]')
          WHERE products.id > ?`)
        .bind(previous)
        .run();
      const oldCount = await legacy.db
        .prepare(`SELECT COUNT(*) AS total FROM product_search_entities e
        WHERE EXISTS (SELECT 1 FROM product_search_entity_offers m
          JOIN products p ON p.id=m.listing_product_id
          WHERE m.entity_id=e.id AND p.is_active=1 AND p.shop_key=? AND p.stock_status='in_stock')`)
        .bind("hifido")
        .all<{ total: number }>();
      assert.equal(oldCount.results?.[0].total, 11);
      for (const filter of [
        "shop=hifido&inStock=true",
        "shop=hifido&inStock=true&manufacturer=luxman",
        "shop=hifido&inStock=true&offer=remote_control&offer=shop_warranty",
        "shop=hifido&shop=missing&inStock=true&manufacturer=luxman&manufacturer=missing",
      ]) {
        const measured = accountReads(db);
        const result = await searchProducts(
          measured.db,
          productQuery(`?${filter}&limit=5&includeTotal=true`),
        );
        assert.equal(result.totalCount, 11);
        assert.equal(result.totalPages, 3);
        assert.equal(result.items.length, 5);
        assert.ok(result.hasMore && result.nextCursor);
        assert.equal(measured.rowsWritten(), 0);
        assert.equal(
          measured.countedStatements(),
          5,
          "count, page, both offer loaders and page-scoped facts are measured",
        );
        costs.push({ size, filter, rowsRead: measured.rowsRead(), legacyCount: legacy.rowsRead() });
      }
      const manufacturer = accountReads(db);
      const result = await searchProducts(
        manufacturer.db,
        productQuery("?manufacturer=luxman&inStock=true&limit=5&includeTotal=true"),
      );
      assert.equal(result.totalCount, 11);
      // Presentation fallback still visits entities, but must not expand the alias JSON per row.
      assert.ok(manufacturer.rowsRead() < size * 3 + 300, `${size}: ${manufacturer.rowsRead()}`);
      assert.equal(manufacturer.rowsWritten(), 0);
      console.log(
        JSON.stringify({
          event: "manufacturer_search_read_measurement",
          size,
          rowsRead: manufacturer.rowsRead(),
        }),
      );
      for (const filter of ["shop=missing", "shop=hifido&inStock=true&maxPrice=1"]) {
        const empty = accountReads(db);
        const page = await searchProducts(empty.db, productQuery(`?${filter}&includeTotal=true`));
        assert.equal(page.totalCount, 0);
        assert.deepEqual(page.items, []);
        assert.equal(empty.countedStatements(), 2);
        assert.ok(empty.rowsRead() < 100, `${size} ${filter}: ${empty.rowsRead()}`);
        assert.equal(empty.rowsWritten(), 0);
      }
      previous = size;
    }
    console.log(JSON.stringify({ event: "shop_search_read_budget", costs }));
    for (const filter of new Set(costs.map((cost) => cost.filter))) {
      const matching = costs.filter((cost) => cost.filter === filter);
      assert.ok(
        matching.every((cost) => cost.rowsRead < 700),
        JSON.stringify(matching),
      );
      assert.ok(matching[2].rowsRead <= matching[0].rowsRead + 30, JSON.stringify(matching));
      assert.ok(matching[2].rowsRead < matching[2].legacyCount / 10, JSON.stringify(matching));
    }
  } finally {
    await dispose();
  }
}, 60_000);

test("filtered price pages bound reads as the matching shops grow", async () => {
  const { db, dispose } = await database();
  try {
    const costs: { size: number; rowsRead: number; statements: number }[] = [];
    let previous = 0;
    for (const size of [100, 1_000, 10_000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (
          SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?
        ) INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,
          first_seen_at,last_seen_at,last_changed_at,last_activity_at,price_yen)
          SELECT i,CASE WHEN i%2=0 THEN 'hifido' ELSE 'audiounion' END,CAST(i AS TEXT),
            'amplifier','https://example.test/'||i,'in_stock',
            '${AT}','${AT}','${AT}','${AT}',100000 FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,
          offer_count,in_stock_offer_count,shop_count)
          SELECT id,'l-'||id,'unresolved_listing',id,1,1,1 FROM products WHERE id>?`)
        .bind(previous)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
          SELECT id,id,shop_key FROM products WHERE id>?`)
        .bind(previous)
        .run();
      const recorded = recordingDatabase(db);
      const measured = accountReads(recorded.db);
      const result = await searchProducts(
        measured.db,
        productQuery(
          "?shop=hifido&shop=audiounion&inStock=true&minPrice=75000&maxPrice=125000&sort=priceAsc&limit=25&includeTotal=true",
        ),
      );
      assert.equal(result.totalCount, size);
      assert.deepEqual(
        result.items.map((item) => item.key),
        Array.from({ length: 25 }, (_, i) => `l-${i + 1}`),
      );
      assert.ok(result.hasMore && result.nextCursor);
      assert.equal(measured.rowsWritten(), 0);
      assert.equal(measured.countedStatements(), 5);
      // Includes the independent exact count and all page loaders. Re-evaluating membership on
      // the page used 16 * size + 272 reads; the matching sort join already proves membership.
      assert.ok(measured.rowsRead() <= 12 * size + 350, `${size}: ${measured.rowsRead()}`);
      costs.push({
        size,
        rowsRead: measured.rowsRead(),
        statements: measured.countedStatements(),
      });
      const page = recorded.executed.find((statement) => statement.sql.includes("matching_sort"));
      assert.ok(page);
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${page.sql}`)
        .bind(...page.binds)
        .all<PlanStep>();
      assert.ok(
        plan.results?.some((step: PlanStep) =>
          /SEARCH p USING INDEX idx_products_shop_active_quality/.test(step.detail),
        ),
        JSON.stringify(plan.results),
      );
      if (size === 10_000)
        console.log(JSON.stringify({ event: "filtered_price_query_plan", plan: plan.results }));
      previous = size;
    }
    console.log(JSON.stringify({ event: "filtered_price_read_budget", costs }));
  } finally {
    await dispose();
  }
}, 60_000);
