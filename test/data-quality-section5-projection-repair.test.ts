import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";

test("section 5 deactivation migration removes inactive offers and refreshes surviving cards", () => {
  const name = "0043_repair_section5_search_projection.sql";
  const { sqlite } = migratedSqlite({ before: name });
  try {
    sqlite.exec(`INSERT INTO products(id,shop_key,source_id,title,source_url,price_yen,stock_status,is_active,first_seen_at,last_seen_at,last_changed_at)
      VALUES(1,'a','1','Active','https://example.test/1',100,'in_stock',1,'2026-08-01','2026-08-01','2026-08-01'),
            (2,'b','2','Inactive','https://example.test/2',200,'sold_out',0,'2026-08-01','2026-08-01','2026-08-01');
      INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id)
      VALUES(1,'l-1','unresolved_listing',1),(2,'l-2','unresolved_listing',2);
      INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key) VALUES(1,1,'a'),(2,2,'b');`);
    const migration = migrationSources.find((row) => row.name === name);
    assert.ok(migration);
    sqlite.exec(migration.sql);
    assert.deepEqual(
      sqlite
        .prepare("SELECT listing_product_id FROM product_search_entity_offers")
        .all()
        .map((row) => ({ ...row })),
      [{ listing_product_id: 1 }],
    );
    assert.deepEqual(
      sqlite
        .prepare("SELECT entity_key,offer_count,lowest_price_yen FROM product_search_entities")
        .all()
        .map((row) => ({ ...row })),
      [{ entity_key: "l-1", offer_count: 1, lowest_price_yen: 100 }],
    );
  } finally {
    sqlite.close();
  }
});
