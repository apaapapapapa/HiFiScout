import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  ADMIN_IDENTITY_PEERS_SQL,
  ADMIN_LISTING_DIAGNOSIS_SQL,
  readAdminListingDiagnosis,
} from "../src/db/admin-diagnostics-repository.js";

test("diagnosis preserves raw evidence, overrides and an unresolved candidate without writes", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(`INSERT INTO products(id, shop_key, source_id, title, source_url,
      first_seen_at, last_seen_at, last_changed_at, raw_manufacturer, manufacturer,
      canonical_manufacturer_id, raw_model, model, normalized_model)
      VALUES (100001, 'test', 'a', 'Seller title', 'https://example.test/a', '2026-01-01', '2026-01-01', '2026-01-01',
      'Seller maker', 'LUXMAN', 'luxman', 'Seller model', 'M-1', 'M1');
      INSERT INTO product_admin_overrides(listing_product_id, model, created_at, updated_at)
      VALUES (100001, 'M-1', '2026-01-01', '2026-01-01');
      INSERT INTO product_identity_resolutions(listing_product_id, status, match_method, confidence, rejected_by_json, evaluated_at)
      VALUES (100001, 'unresolved', 'none', 'none', '["category_conflict"]', '2026-01-02');`);
    const changes = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    const data = await readAdminListingDiagnosis(db, 100001);
    assert.ok(data);
    assert.equal(data.seller.manufacturer, "Seller maker");
    assert.equal(data.seller.model, "Seller model");
    assert.equal(data.decision.model, "M-1");
    assert.equal(data.overrides["型番"], "M-1");
    assert.equal(data.identity.catalogId, null);
    assert.equal(data.identity.rejectedBy, '["category_conflict"]');
    assert.equal(data.search.key, null);
    assert.equal(data.search.pending, 1, "new listings carry a durable projection obligation");
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changes);
    assert.equal(await readAdminListingDiagnosis(db, 999999), null);
    await assert.rejects(readAdminListingDiagnosis(db, 0), /invalid_listing_id/u);
  } finally {
    sqlite.close();
  }
});

test("diagnosis peer reads are capped and use the identity index without a temporary sort", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    const insert = sqlite.prepare(`INSERT INTO products(shop_key, source_id, title, source_url,
      first_seen_at, last_seen_at, last_changed_at, canonical_manufacturer_id, normalized_model)
      VALUES ('test', ?, 'title', '', '', '', '', ?, 'M1')`);
    let id = 0;
    for (let i = 0; i < 1025; i++) {
      const result = insert.run(String(i), i < 25 ? "luxman" : `unrelated-${i}`);
      if (!i) id = Number(result.lastInsertRowid);
    }
    const data = await readAdminListingDiagnosis(db, id);
    assert.equal(data?.peers.length, 20);
    assert.equal(data?.peersHasMore, true);
    const plans = [
      ...sqlite.prepare(`EXPLAIN QUERY PLAN ${ADMIN_LISTING_DIAGNOSIS_SQL}`).all(id),
      ...sqlite.prepare(`EXPLAIN QUERY PLAN ${ADMIN_IDENTITY_PEERS_SQL}`).all("luxman", "M1"),
    ]
      .map((row) => String(row.detail))
      .join("\n");
    assert.match(plans, /SEARCH p USING INDEX idx_products_exact_identity/u);
    assert.doesNotMatch(plans, /SCAN |USE TEMP B-TREE/u);
  } finally {
    sqlite.close();
  }
});

test("diagnosis reads both durable pending tables independently of the remediation flag", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(`INSERT INTO products(id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at)
      VALUES (100001, 'test', 'pending', 'title', '', '', '', '');`);
    assert.equal((await readAdminListingDiagnosis(db, 100001))?.search.pending, 1);
    sqlite.exec("DELETE FROM listing_projection_pending WHERE listing_product_id = 100001");
    assert.equal((await readAdminListingDiagnosis(db, 100001))?.search.pending, 0);
    sqlite.exec(
      "INSERT INTO product_search_catalog_pending(listing_product_id, token) VALUES (100001, 'catalog-transition')",
    );
    assert.equal((await readAdminListingDiagnosis(db, 100001))?.search.pending, 1);
    sqlite.exec(
      "DELETE FROM product_search_catalog_pending WHERE listing_product_id = 100001; UPDATE products SET remediation_projection_required = 1 WHERE id = 100001",
    );
    assert.equal((await readAdminListingDiagnosis(db, 100001))?.search.pending, 1);
  } finally {
    sqlite.close();
  }
});
