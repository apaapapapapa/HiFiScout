import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { loadKnowledgeCatalogPriceIndexes } from "../src/db/knowledge-catalog-price-index-read.js";

test("repeated discounts remain one independent listing and cannot enable a market badge", async () => {
  const { db, sqlite } = migratedSqlite();
  sqlite.exec(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
    VALUES(999901,'price-test','ONE','ONE','ONE','2026-09-05','2026-09-05');
    INSERT INTO product_search_entities(entity_key,entity_kind,catalog_product_id,lowest_price_yen,lowest_in_stock_price_yen)
    VALUES('c-999901','catalog',999901,200000,200000);`);
  const insert =
    sqlite.prepare(`INSERT INTO knowledge_catalog_price_index_samples(event_key,catalog_product_id,listing_product_id,shop_key,source_id,sample_kind,signal_kind,price_yen,observed_at)
    VALUES(?,999901,?,?,?,'asking','asking',?,?)`);
  for (const [n, price] of [300000, 250000, 200000].entries())
    insert.run(`one-${n}`, 1, "one", "one", price, `2026-09-05T0${n}:00:00.000Z`);
  const first = sqlite
    .prepare("SELECT * FROM knowledge_catalog_price_indexes WHERE catalog_product_id=999901")
    .get();
  assert.equal(first?.asking_sample_count, 3);
  assert.equal(first?.asking_listing_count, 1);
  assert.equal(first?.asking_shop_count, 1);
  assert.equal(first?.asking_median_yen, 200000);
  assert.equal((await loadKnowledgeCatalogPriceIndexes(db, [999901])).size, 0);
  assert.equal(
    sqlite
      .prepare("SELECT listing_deal_score FROM product_search_entities WHERE entity_key='c-999901'")
      .get()?.listing_deal_score,
    null,
  );
  insert.run("two", 2, "two", "two", 300000, "2026-09-05T03:00:00.000Z");
  insert.run("three", 3, "three", "three", 400000, "2026-09-05T04:00:00.000Z");
  const summary = (await loadKnowledgeCatalogPriceIndexes(db, [999901])).get(999901);
  assert.equal(summary?.asking_listing_count, 3);
  assert.equal(summary?.asking_sample_count, 5);
  assert.equal(summary?.asking_shop_count, 3);
  assert.equal(summary?.asking_median_yen, 300000);
  assert.equal(summary?.latest_asking_observed_at, "2026-09-05T04:00:00.000Z");
});
