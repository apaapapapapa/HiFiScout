import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { database, AT } from "./helpers/d1-write-budget.js";
import { addHealthListings } from "./helpers/health-fixture.js";
import { runHealthScript } from "./helpers/health-cli.js";
import { EXACT_IDENTITY_SPLIT_COUNT_SQL } from "../src/db/product-search-exact-identity.js";

// Workerd startup, schema migration and 10k-row fixture setup share the D1 integration allowance.
// SQL regression gates below use billed rows, not wall-clock timing.
const fullSql = readFileSync("scripts/sql/search-entity-health.sql", "utf8");
const recheckSql = readFileSync("scripts/sql/search-entity-health-recheck.sql", "utf8");
const qualitySql = readFileSync("scripts/sql/latest-quality-runs.sql", "utf8");

test("full health audit keeps exact counts with linear reads and no persistent writes", async () => {
  const { db, dispose } = await database();
  try {
    const empty = (await db.prepare(fullSql).all<Record<string, number | string>>()).results[0];
    assert.ok(
      Object.entries(empty).every(([key, value]) => value === (key.endsWith("_ids") ? "[]" : 0)),
    );
    let previous = 0;
    const costs = [];
    for (const size of [100, 1000, 10000]) {
      await addHealthListings(db, previous + 1, size);
      previous = size;
      const result = await db.prepare(fullSql).all<Record<string, number | string>>();
      assert.equal(result.results[0].entity_count, size);
      assert.equal(result.results[0].offer_count, size);
      assert.equal(result.results[0].fallback_entity_count, size);
      assert.equal(result.results[0].entity_ids, "[]");
      assert.equal(result.results[0].listing_ids, "[]");
      assert.equal(result.meta.rows_written, 0);
      // One complete audit remains O(active listings + memberships + entities), not O(1).
      assert.ok(result.meta.rows_read <= 13 * size + 30, JSON.stringify(result.meta));
      costs.push({ size, reads: result.meta.rows_read, writes: result.meta.rows_written });
    }
    console.log(JSON.stringify({ event: "full_health_read_budget", costs }));
  } finally {
    await dispose();
  }
}, 30_000);

test("full health flags overlapping faults without losing captured listing or entity IDs", async () => {
  const { db, dispose } = await database();
  try {
    await addHealthListings(db, 1, 8);
    await db
      .prepare(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,
      verification_status,created_at,updated_at) VALUES
      (1,'maker','Verified','VERIFIED','verified','${AT}','${AT}'),
      (2,'maker','Rejected','REJECTED','rejected','${AT}','${AT}');
      UPDATE product_identity_resolutions SET status='matched',catalog_product_id=1 WHERE listing_product_id=2;
      UPDATE product_search_entities SET entity_kind='catalog',catalog_product_id=2,fallback_listing_id=NULL WHERE id=3;
      DELETE FROM product_search_entities WHERE id IN (7,8);
      DELETE FROM product_search_entity_offers WHERE listing_product_id IN (4,6);
      UPDATE products SET is_active=0 WHERE id IN (7,8);
      INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key) VALUES
        (7,6,'audiounion'),(8,5,'audiounion');
      UPDATE product_search_entities SET offer_count=2,shop_count=2 WHERE id=5;`)
      .run();
    const result = await db.prepare(fullSql).all<Record<string, number | string>>();
    const row = result.results[0];
    assert.deepEqual(
      { ...row, entity_ids: undefined, listing_ids: undefined },
      {
        entity_count: 6,
        catalog_entity_count: 1,
        fallback_entity_count: 5,
        multi_shop_entity_count: 1,
        offer_count: 6,
        unmembered_active_listings: 2,
        inactive_offer_memberships: 2,
        entities_without_offers: 1,
        stale_fallback_entities: 1,
        ineligible_catalog_entities: 1,
        offer_count_mismatches: 3,
        entity_ids: undefined,
        listing_ids: undefined,
      },
    );
    assert.deepEqual(JSON.parse(String(row.entity_ids)), [2, 3, 4, 5, 6]);
    assert.deepEqual(JSON.parse(String(row.listing_ids)), [2, 3, 4, 5, 6, 7, 8]);
    assert.equal(result.meta.rows_written, 0);
  } finally {
    await dispose();
  }
}, 30_000);

test("split-identity rechecks seek captured keys even after a seed disappears", async () => {
  const { db, dispose } = await database();
  try {
    const split = [{ canonical_manufacturer_id: "maker's", normalized_model: "X'2 $() `x`" }];
    const invocation = runHealthScript("scripts/product-search-identity-health.sh", [split, []]);
    assert.equal(invocation.status, 0, invocation.stderr);
    const sql = invocation.sql[1];
    await addHealthListings(db, 1, 3);
    await db
      .prepare("UPDATE products SET canonical_manufacturer_id=?,normalized_model=? WHERE id<=3")
      .bind(split[0].canonical_manufacturer_id, split[0].normalized_model)
      .run();
    const small = await db.prepare(sql).all<{ listing_count: number }>();
    assert.equal(small.results[0].listing_count, 3);
    await addHealthListings(db, 4, 10000);
    const large = await db.prepare(sql).all<{ listing_count: number }>();
    assert.equal(large.results[0].listing_count, 3);
    assert.ok(large.meta.rows_read <= small.meta.rows_read + 5);
    assert.ok(large.meta.rows_read < 80, JSON.stringify(large.meta));
    assert.equal(large.meta.rows_written, 0);
    await db.prepare("DELETE FROM products WHERE id=1").run();
    assert.equal(
      (await db.prepare(sql).all<{ listing_count: number }>()).results[0].listing_count,
      2,
    );
    await db
      .prepare("UPDATE product_search_entity_offers SET entity_id=2 WHERE listing_product_id=3")
      .run();
    assert.deepEqual((await db.prepare(sql).all()).results, []);
    const plan = (await db.prepare("EXPLAIN QUERY PLAN " + sql).all<{ detail: string }>()).results;
    assert.ok(
      plan.some((row: { detail: string }) =>
        /SEARCH p USING INDEX idx_products_exact_identity.*canonical_manufacturer_id=\? AND normalized_model=\?/.test(
          row.detail,
        ),
      ),
    );
    console.log(
      JSON.stringify({
        event: "split_health_recheck_budget",
        small: small.meta.rows_read,
        large: large.meta.rows_read,
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("split health uses runtime eligibility and category rules in both observations", async () => {
  const { db, dispose } = await database();
  try {
    const invocation = runHealthScript("scripts/product-search-identity-health.sh", [
      [{ canonical_manufacturer_id: "maker", normalized_model: "MODEL" }],
      [],
    ]);
    assert.equal(invocation.status, 0, invocation.stderr);
    await addHealthListings(db, 1, 3);
    await db
      .prepare("UPDATE products SET normalized_model='MODEL',primary_category_id='AMP.PRE'")
      .run();
    const check = async (expected: number, reason: string) => {
      const runtime = await db
        .prepare(EXACT_IDENTITY_SPLIT_COUNT_SQL)
        .first<{ split_exact_identity_groups: number }>();
      assert.equal(runtime?.split_exact_identity_groups, expected, reason);
      for (const sql of invocation.sql) {
        const result = await db.prepare(sql).all();
        assert.equal(result.results.length, expected, reason);
        assert.equal(result.meta.rows_written, 0);
      }
    };
    await check(1, "ordinary safe peers remain detectable");
    await db
      .prepare(`UPDATE product_identity_resolutions SET match_method='vetoed' WHERE listing_product_id=3;
      UPDATE products SET primary_category_id='AMP.INTEGRATED' WHERE id=3;`)
      .run();
    await check(1, "a vetoed category contradiction must not hide a real split");
    await db
      .prepare(`UPDATE product_identity_resolutions SET match_method='vetoed' WHERE listing_product_id=2;
      UPDATE products SET primary_category_id='AMP.PRE' WHERE id=3;`)
      .run();
    await check(0, "vetoed listings must not create a false split");
    await db
      .prepare(`UPDATE product_identity_resolutions SET match_method='none' WHERE listing_product_id=2;
      UPDATE products SET model_resolution_status='candidate' WHERE id=2;`)
      .run();
    await check(0, "candidate models remain excluded");
    await db
      .prepare(`UPDATE products SET model_resolution_status='resolved' WHERE id=2;
      UPDATE products SET primary_category_id='AMP.INTEGRATED' WHERE id=3;
      INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,
        verification_status,created_at,updated_at)
      VALUES(1,'maker','MODEL','MODEL','verified','${AT}','${AT}');
      UPDATE product_identity_resolutions SET status='matched',match_method='exact',catalog_product_id=1
      WHERE listing_product_id=3;`)
      .run();
    await check(1, "verified catalog matches do not veto fallback grouping");
    await db
      .prepare("UPDATE knowledge_catalog_products SET verification_status='rejected' WHERE id=1")
      .run();
    await check(
      0,
      "a rejected match remains eligible and its category contradiction vetoes grouping",
    );
    await db
      .prepare(`DELETE FROM product_identity_resolutions WHERE listing_product_id=3;
      DELETE FROM product_search_entity_offers WHERE listing_product_id=3;`)
      .run();
    await check(0, "a missing membership must not hide an eligible category contradiction");
    await db.prepare("UPDATE products SET primary_category_id='unclassified' WHERE id=3").run();
    await check(1, "an unspecified category is not a contradiction");
  } finally {
    await dispose();
  }
}, 30_000);

test("initial split health seeks active resolved listings without scanning retired history", async () => {
  const { db, dispose } = await database();
  try {
    const sql = runHealthScript("scripts/product-search-identity-health.sh", [[]]).sql[0];
    await addHealthListings(db, 1, 3);
    await db.prepare("UPDATE products SET normalized_model='MODEL'").run();
    const small = await db.prepare(sql).all();
    assert.equal(small.results.length, 1);
    await addHealthListings(db, 4, 10003);
    // Historical listings have no live cards and must not increase an active audit's reads.
    await db
      .prepare(
        "UPDATE products SET is_active=0 WHERE id>3; DELETE FROM product_search_entities WHERE id>3;",
      )
      .run();
    const large = await db.prepare(sql).all();
    assert.deepEqual(large.results, small.results);
    assert.ok(
      large.meta.rows_read <= small.meta.rows_read + 5,
      JSON.stringify({ small: small.meta, large: large.meta }),
    );
    assert.ok(large.meta.rows_read < 40);
    assert.equal(large.meta.rows_written, 0);
    const plan = (await db.prepare("EXPLAIN QUERY PLAN " + sql).all<{ detail: string }>()).results;
    assert.ok(
      plan.some((row: { detail: string }) =>
        /SEARCH p USING INDEX idx_products_model_resolution.*model_resolution_status=\? AND is_active=\?/.test(
          row.detail,
        ),
      ),
    );
    console.log(
      JSON.stringify({
        event: "initial_split_health_read_budget",
        small: small.meta.rows_read,
        large: large.meta.rows_read,
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("convergence polls do not scan unrelated listings or terminal crawl history", async () => {
  const { db, dispose } = await database();
  try {
    const gap = [{ id: 1 }],
      active = [{ shop_key: "audiounion", active_session_count: 1 }];
    const invocation = runHealthScript("scripts/wait-for-active-crawl-convergence.sh", [
      gap,
      active,
      [],
      [],
    ]);
    assert.equal(invocation.status, 0, invocation.stderr);
    await addHealthListings(db, 1, 1);
    await db
      .prepare(`DELETE FROM product_identity_resolutions WHERE listing_product_id=1;
      INSERT INTO crawl_fetch_sessions(run_id,shop_key,status,requested_at,created_at,updated_at,max_pages,page_limit)
      VALUES('current','audiounion','collecting','${AT}','${AT}','${AT}',10,100);`)
      .run();
    const small = await db.prepare(invocation.sql[1]).all();
    assert.equal(small.results.length, 1);
    await addHealthListings(db, 2, 10000);
    await db
      .prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO crawl_fetch_sessions(run_id,shop_key,status,requested_at,created_at,updated_at,max_pages,page_limit)
      SELECT 'old-'||i,'retired','completed',CAST(i AS TEXT),'${AT}','${AT}',10,100 FROM n;`)
      .run();
    const large = await db.prepare(invocation.sql[1]).all();
    assert.equal(large.results.length, 1);
    assert.ok(large.meta.rows_read <= small.meta.rows_read + 5);
    assert.ok(large.meta.rows_read < 40, JSON.stringify(large.meta));
    const recheck = await db.prepare(invocation.sql[3]).all<{ id: number }>();
    assert.deepEqual(
      recheck.results.map((row: { id: number }) => row.id),
      [1],
    );
    assert.ok(recheck.meta.rows_read < 15, JSON.stringify(recheck.meta));
    assert.equal(large.meta.rows_written + recheck.meta.rows_written, 0);
    console.log(
      JSON.stringify({
        event: "convergence_health_read_budget",
        small: small.meta.rows_read,
        large: large.meta.rows_read,
        recheck: recheck.meta.rows_read,
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);

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
}, 30_000);

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
}, 30_000);
