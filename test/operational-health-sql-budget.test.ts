import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { database, AT } from "./helpers/d1-write-budget.js";

const fullSql = readFileSync("scripts/sql/search-entity-health.sql", "utf8");
const recheckSql = readFileSync("scripts/sql/search-entity-health-recheck.sql", "utf8");
const qualitySql = readFileSync("scripts/sql/latest-quality-runs.sql", "utf8");

test("health retries use captured IDs and detect a deleted fallback that left a coverage gap", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`INSERT INTO products(id, shop_key, source_id, title, source_url,
        first_seen_at, last_seen_at, last_changed_at, is_active)
      VALUES (1, 'shop', 'one', 'One', 'https://example.test/one', '${AT}', '${AT}', '${AT}', 1);
      INSERT INTO product_search_entities(id, entity_key, entity_kind, fallback_listing_id, offer_count)
      VALUES (1, 'l-1', 'unresolved_listing', 1, 1);
      INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key) VALUES (1, 1, 'shop');
      INSERT INTO knowledge_catalog_products(id, manufacturer_id, canonical_model, normalized_model,
        created_at, updated_at) VALUES (1, 'luxman', 'C10', 'C10', '${AT}', '${AT}');
      INSERT INTO product_identity_resolutions(listing_product_id, status, catalog_product_id,
        match_method, confidence, evaluated_at)
      VALUES (1, 'matched', 1, 'exact', 'high', '${AT}');`)
      .run();
    const observed = (
      await db
        .prepare(fullSql)
        .all<{ entity_ids: string; listing_ids: string; stale_fallback_entities: number }>()
    ).results[0];
    assert.equal(observed.stale_fallback_entities, 1);
    const sql = recheckSql
      .replace("__ENTITY_IDS__", observed.entity_ids)
      .replace("__LISTING_IDS__", observed.listing_ids);
    const small = await db.prepare(sql).all();
    await db
      .prepare(`WITH RECURSIVE n(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM n WHERE i < 10001)
      INSERT INTO products(id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
      SELECT i, 'shop', CAST(i AS TEXT), 'Unrelated', 'https://example.test/'||i, '${AT}', '${AT}', '${AT}', 0 FROM n;`)
      .run();
    const large = await db
      .prepare(sql)
      .all<{ stale_fallback_entities: number; unmembered_active_listings: number }>();
    assert.equal(large.results[0].stale_fallback_entities, 1);
    assert.ok(large.meta.rows_read <= small.meta.rows_read + 5);
    assert.ok(large.meta.rows_read < 100, `one-entity retry read ${large.meta.rows_read} rows`);
    await db.prepare("DELETE FROM product_search_entities WHERE id = 1").run();
    const deleted = (
      await db
        .prepare(sql)
        .all<{ stale_fallback_entities: number; unmembered_active_listings: number }>()
    ).results[0];
    assert.equal(deleted.stale_fallback_entities, 0);
    assert.equal(deleted.unmembered_active_listings, 1, "deletion alone is not convergence");
    await db
      .prepare(`INSERT INTO product_search_entities(id, entity_key, entity_kind, catalog_product_id, offer_count)
      VALUES (2, 'c-1', 'catalog', 1, 1);
      INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key) VALUES (1, 2, 'shop');`)
      .run();
    const repaired = (await db.prepare(sql).all<Record<string, number>>()).results[0];
    assert.ok(Object.values(repaired).every((value) => value === 0));
    await db
      .prepare(`UPDATE products SET is_active = 0 WHERE id = 1;
      UPDATE product_search_entities SET offer_count = 0 WHERE id = 2;`)
      .run();
    const inactive = (await db.prepare(fullSql).all<{ entity_ids: string; listing_ids: string }>())
      .results[0];
    const inactiveSql = recheckSql
      .replace("__ENTITY_IDS__", inactive.entity_ids)
      .replace("__LISTING_IDS__", inactive.listing_ids);
    await db.prepare("DELETE FROM product_search_entity_offers WHERE listing_product_id = 1").run();
    const empty = (await db.prepare(inactiveSql).all<{ entities_without_offers: number }>())
      .results[0];
    assert.equal(
      empty.entities_without_offers,
      1,
      "removing an inactive offer must also remove its empty entity",
    );
  } finally {
    await dispose();
  }
});

test("latest quality rows seek shops and break timestamp ties without scanning history", async () => {
  const { db, dispose } = await database();
  try {
    const insert = (count: number) =>
      db
        .prepare(`WITH RECURSIVE n(i) AS (
        VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < ${count})
      INSERT INTO data_quality_runs(shop_key, evaluated_at, quality_status,
        manufacturer_status, category_status, identity_status, inventory_status, model_status,
        parser_status, item_count_status, evidence_status, snapshot_status, run_status)
      SELECT CASE WHEN i % 2 = 0 THEN 'retired-shop' ELSE 'current-shop' END,
        '2026-01-01', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy', 'healthy',
        'healthy', 'healthy', 'healthy', 'healthy', 'healthy' FROM n;`)
        .run();
    await insert(10);
    const small = await db.prepare(qualitySql).all<{ id: number; shop_key: string }>();
    await insert(10000);
    const large = await db.prepare(qualitySql).all<{ id: number; shop_key: string }>();
    assert.deepEqual(
      large.results.map((row: { shop_key: string; id: number }) => [row.shop_key, row.id]),
      [
        ["current-shop", 10009],
        ["retired-shop", 10010],
      ],
    );
    assert.ok(
      large.meta.rows_read <= small.meta.rows_read + 5,
      `history changed reads from ${small.meta.rows_read} to ${large.meta.rows_read}`,
    );
    assert.ok(large.meta.rows_read < 40);
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${qualitySql}`).all<{ detail: string }>();
    assert.ok(
      plan.results.some(
        (row: { detail: string }) =>
          row.detail.includes("idx_data_quality_shop_latest") && row.detail.includes("shop_key>"),
      ),
    );
    assert.ok(
      plan.results.every((row: { detail: string }) => !/SCAN (q|latest)( |$)/.test(row.detail)),
    );
    await db.prepare("DELETE FROM data_quality_runs").run();
    assert.deepEqual((await db.prepare(qualitySql).all()).results, []);
  } finally {
    await dispose();
  }
});
