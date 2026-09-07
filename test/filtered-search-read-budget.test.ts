import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { searchProducts } from "../src/db/product-search-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { productQuery } from "./helpers/product-query.js";

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
        .prepare(`INSERT INTO product_offer_facts
          SELECT products.id, value, 'seller', 'present', 'condition_text', 'fixture', 1, '${AT}'
          FROM products CROSS JOIN json_each('["remote_control","shop_warranty"]')
          WHERE products.id > ? AND products.id <= 12`)
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
          4,
          "count, page and both offer loaders are measured",
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
