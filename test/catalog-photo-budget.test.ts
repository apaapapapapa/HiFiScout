import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { productQuery } from "./helpers/product-query.js";
import { recordCostSample } from "../scripts/harness/cost.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { updateCatalogPhoto } from "../src/db/catalog-photo-repository.js";

test("photo search and edits stay bounded as unrelated catalog photos grow; replay writes nothing", async () => {
  const { db, dispose } = await database();
  const photo = {
    imageUrl: "https://www.luxman.co.jp/photo.jpg",
    sourceUrl: "https://www.luxman.co.jp/product/",
    credit: "LUXMAN",
  };
  const fixture = ["test/catalog-photo-budget.test.ts"];
  try {
    let previous = 0;
    for (const size of [100, 10000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
        INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,verification_status,created_at,updated_at)
        SELECT i,'luxman','P-'||i,'P'||i,'verified','2026-09-22','2026-09-22' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(
          `INSERT INTO catalog_product_photos SELECT id, ?, 1, '2026-09-22' FROM knowledge_catalog_products WHERE id > ?`,
        )
        .bind(JSON.stringify(photo), previous)
        .run();
      if (!previous) {
        await db
          .prepare(`INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,first_seen_at,last_seen_at,last_changed_at,price_yen)
          SELECT id,'hifido',CAST(id AS TEXT),'P-'||id,'https://example.com/'||id,'in_stock','2026-09-22','2026-09-22','2026-09-22',100000 FROM knowledge_catalog_products WHERE id <= 20`)
          .run();
        await db
          .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,catalog_product_id,model,offer_count,in_stock_offer_count,shop_count)
          SELECT id,'c-'||id,'catalog',id,'P-'||id,1,1,1 FROM knowledge_catalog_products WHERE id <= 20`)
          .run();
        await db
          .prepare(
            `INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key) SELECT id,id,'hifido' FROM products`,
          )
          .run();
      }
      const boundary = measureD1Cost(db);
      const result = await searchProducts(boundary.db, productQuery("?inStock=true&limit=10"));
      assert.equal(result.items.length, 10);
      assert.ok(result.items.every((item) => item.photo?.imageUrl === photo.imageUrl));
      const cost = boundary.metrics();
      await recordCostSample(`catalog-photo-search-${size}`, "local-workerd", cost, fixture, [
        `10-result page with ${size} catalog photos; real migrated D1.`,
      ]);
      assert.equal(cost.rowsWritten, 0);
      assert.ok(cost.rowsRead !== null && cost.rowsRead <= 200, JSON.stringify(cost));
      assert.ok(cost.sqlStatements <= 8);
      console.log(JSON.stringify({ sample: `catalog-photo-search-${size}`, ...cost }));
      previous = size;
    }
    for (const changed of [false, true]) {
      const boundary = measureD1Cost(db);
      const saved = await updateCatalogPhoto(boundary.db, 1, {
        photo: changed ? { ...photo, credit: "updated" } : photo,
        expectedRevision: 1,
      });
      assert.equal(saved?.revision, changed ? 2 : 1);
      const cost = boundary.metrics();
      const sample = changed ? "catalog-photo-update" : "catalog-photo-replay";
      await recordCostSample(sample, "local-workerd", cost, fixture, [
        "One catalog model amid 10,000 photos; unchanged requests do not write.",
      ]);
      assert.equal(cost.rowsWritten, changed ? 1 : 0);
      assert.ok(cost.rowsRead !== null && cost.rowsRead <= 20, JSON.stringify(cost));
      assert.equal(cost.sqlStatements, changed ? 3 : 1);
      console.log(JSON.stringify({ sample, ...cost }));
    }
  } finally {
    await dispose();
  }
}, 60000);
