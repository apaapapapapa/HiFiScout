import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { auditInactiveSearchMemberships } from "../src/db/product-search-membership-audit.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

test("daily audit crosses healthy windows and preserves failed or over-budget legacy gaps", async () => {
  const { sqlite, db } = migratedSqlite();
  sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10)
    INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at)
    SELECT i,'audit',CAST(i AS TEXT),'unknown','https://example.test','2026-09-06','2026-09-06','2026-09-06' FROM n;
    INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id)
    SELECT id,'l-'||id,'unresolved_listing',id FROM products;
    INSERT INTO product_search_entity_offers SELECT id,id,shop_key FROM products;
    UPDATE products SET is_active=0 WHERE id IN (8,9);
    DELETE FROM listing_projection_pending`);
  const healthy = await auditInactiveSearchMemberships(db, { scanLimit: 5, repairLimit: 1 });
  assert.deepEqual(healthy, { scannedCount: 5, repairedCount: 0, nextAfterId: 5 });
  sqlite.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON product_search_entity_offers
    WHEN OLD.listing_product_id=8 BEGIN SELECT RAISE(ABORT,'forced cleanup failure'); END`);
  await assert.rejects(
    auditInactiveSearchMemberships(db, { scanLimit: 5, repairLimit: 1 }),
    /forced cleanup failure/,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT after_id FROM product_projection_audit_cursors WHERE phase='inactive-memberships'",
      )
      .get()?.after_id,
    5,
  );
  sqlite.exec("DROP TRIGGER fail_cleanup");
  const first = await auditInactiveSearchMemberships(db, { scanLimit: 5, repairLimit: 1 });
  assert.equal(first.nextAfterId, 8, "the budget must not skip the second gap");
  assert.equal(first.repairedCount, 1);
  const second = await auditInactiveSearchMemberships(db, { scanLimit: 5, repairLimit: 1 });
  assert.equal(second.repairedCount, 1);
  assert.equal(second.nextAfterId, 0, "wrap only after the tail has been accounted for");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM product_search_entity_offers").get()?.n,
    8,
  );
});
