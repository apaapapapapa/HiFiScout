import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { searchProducts } from "../src/db/product-search-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { productQuery } from "./helpers/product-query.js";

test("common facet filters stay linear in entities instead of scanning all facts per entity", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`WITH RECURSIVE n(i) AS (
        SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000
      ) INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,
        is_active,first_seen_at,last_seen_at,last_changed_at,last_activity_at,price_yen)
        SELECT i,'fixture',CAST(i AS TEXT),'fixture','https://example.test/'||i,'in_stock',
          1,'${AT}','${AT}','${AT}','${AT}',i
        FROM n`)
      .run();
    await db
      .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,
        manufacturer_id,manufacturer,model,offer_count,in_stock_offer_count,shop_count,
        lowest_price_yen,lowest_in_stock_price_yen,highest_price_yen,
        latest_activity_at,newest_listed_at,latest_in_stock_activity_at,newest_in_stock_listed_at)
        SELECT id,'l-'||id,'unresolved_listing',id,'fixture','Fixture','Model',1,1,1,
          price_yen,price_yen,price_yen,'${AT}','${AT}','${AT}','${AT}' FROM products`)
      .run();
    await db
      .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        SELECT id,id,shop_key FROM products`)
      .run();
    await db
      .prepare(`INSERT INTO product_facet_facts(product_id,facet_id,facet_value,source,confidence)
        SELECT id,'connectivity','wireless','fixture',1 FROM products`)
      .run();

    const measured = accountReads(db);
    const result = await searchProducts(
      measured.db,
      productQuery("?facet=connectivity:wireless&inStock=true&sort=priceDesc&limit=50"),
    );
    assert.equal(result.items.length, 50);
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(measured.rowsRead() < 2_000, String(measured.rowsRead()));
  } finally {
    await dispose();
  }
}, 60_000);
