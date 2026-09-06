import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { syncProductSearchEntities } from "../src/db/product-search-entity-repository.js";
import { repairActiveListingProjectionGaps } from "../src/db/product-search-gap-repair.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { productQuery } from "./helpers/product-query.js";

test("unchanged projection and empty pending work stay bounded as unrelated rows grow", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`INSERT INTO knowledge_catalog_products(id, manufacturer_id, canonical_model,
      normalized_model, canonical_name, verification_status, created_at, updated_at)
      VALUES(1,'luxman','C10','C10','LUXMAN C10','verified','${AT}','${AT}')`)
      .run();
    const costs: { size: number; replay: number; emptyRepair: number }[] = [];
    let previous = 0;
    for (const size of [100, 1_000, 10_000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,is_active)
        SELECT i,'budget',CAST(i AS TEXT),'unknown','https://example.test/'||i,'${AT}','${AT}','${AT}',
          CASE WHEN i<=2 THEN 1 ELSE 0 END FROM n`)
        .bind(previous + 1, size)
        .run();
      await db.batch([
        db
          .prepare(`INSERT INTO product_identity_resolutions(listing_product_id,status,match_method,confidence,evaluated_at)
          SELECT id,'unresolved','unresolved','none','${AT}' FROM products WHERE id>?`)
          .bind(previous),
        db
          .prepare(`INSERT INTO product_search_entities(entity_key,entity_kind,fallback_listing_id)
          SELECT 'l-'||id,'unresolved_listing',id FROM products WHERE id>? AND id>1`)
          .bind(previous),
      ]);
      await db
        .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        SELECT p.id,e.id,p.shop_key FROM products p JOIN product_search_entities e ON e.entity_key='l-'||p.id
        WHERE p.id>? AND p.id>1`)
        .bind(previous)
        .run();
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,
          canonical_name,verification_status,created_at,updated_at)
        SELECT 50000+i,'luxman','OTHER-'||i,'OTHER-'||i,'unrelated','verified','${AT}','${AT}' FROM n`)
        .bind(previous + 1, size)
        .run();
      if (!previous) {
        await db
          .prepare(
            "UPDATE product_identity_resolutions SET catalog_product_id=1,status='matched',match_method='catalog_alias',confidence='high' WHERE listing_product_id=1",
          )
          .run();
        await syncProductSearchEntities(db, "budget", ["1", "2"]);
      }
      const replay = accountReads(db);
      const synchronized = await syncProductSearchEntities(replay.db, "budget", ["1", "2"]);
      assert.equal(synchronized.listing_count, 2);
      assert.equal(replay.rowsWritten(), 0, "unchanged projection must not add writes");
      assert.ok(replay.rowsRead() < 800, `${size} rows: replay read ${replay.rowsRead()}`);
      await db
        .prepare(
          "DELETE FROM listing_projection_pending; DELETE FROM product_projection_audit_cursors",
        )
        .run();
      const empty = accountReads(db);
      const result = await repairActiveListingProjectionGaps(empty.db, {
        phases: "coverage",
        maxListings: 2,
        maxScannedListings: 5,
        batchSize: 2,
      });
      assert.equal(result.selectedCount, 0, JSON.stringify({ size, result }));
      assert.ok(empty.rowsRead() < 150, `${size} rows: empty repair read ${empty.rowsRead()}`);
      costs.push({ size, replay: replay.rowsRead(), emptyRepair: empty.rowsRead() });
      previous = size;
    }
    assert.ok(costs[2].replay <= costs[0].replay + 20, JSON.stringify(costs));
    assert.ok(costs[2].emptyRepair <= costs[0].emptyRepair + 20, JSON.stringify(costs));
    console.log(JSON.stringify({ event: "observed_projection_read_budget", costs }));
  } finally {
    await dispose();
  }
}, 60_000);

test("in-stock date pages avoid full offer aggregation as the result set grows", async () => {
  const { db, dispose } = await database();
  try {
    let previous = 0;
    const costs: { size: number; sort: string; rowsRead: number }[] = [];
    for (const size of [100, 1_000, 10_000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,first_seen_at,last_seen_at,last_changed_at,last_activity_at)
        SELECT i,'budget',CAST(i AS TEXT),'unknown','https://example.test/'||i,'in_stock','${AT}','${AT}','${AT}','${AT}' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entities(entity_key,entity_kind,fallback_listing_id,
        offer_count,in_stock_offer_count,shop_count,latest_activity_at,newest_listed_at,
        latest_in_stock_activity_at,newest_in_stock_listed_at)
        SELECT 'l-'||id,'unresolved_listing',id,1,1,1,'${AT}','${AT}','${AT}','${AT}' FROM products WHERE id>?`)
        .bind(previous)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        SELECT p.id,e.id,p.shop_key FROM products p JOIN product_search_entities e ON e.entity_key='l-'||p.id WHERE p.id>?`)
        .bind(previous)
        .run();
      for (const sort of ["newest", "oldest", "updated"]) {
        const measured = accountReads(db);
        const page = await searchProducts(
          measured.db,
          productQuery(`?inStock=true&sort=${sort}&limit=10`),
        );
        assert.equal(page.items.length, 10);
        assert.equal(page.items[0].key, sort === "oldest" ? "l-1" : `l-${size}`);
        assert.ok(page.hasMore && page.nextCursor);
        assert.equal(measured.rowsWritten(), 0);
        assert.ok(measured.rowsRead() < 200, `${size} ${sort}: ${measured.rowsRead()} reads`);
        costs.push({ size, sort, rowsRead: measured.rowsRead() });
      }
      previous = size;
    }
    for (const sort of ["newest", "oldest", "updated"]) {
      const matching = costs.filter((cost) => cost.sort === sort);
      assert.ok(matching[2].rowsRead <= matching[0].rowsRead + 10, JSON.stringify(matching));
    }
    console.log(JSON.stringify({ event: "in_stock_search_read_budget", costs }));
  } finally {
    await dispose();
  }
}, 60_000);
