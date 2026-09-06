import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { claimShopMembershipCleanupChunk } from "../src/db/crawl-run-continuation-repository.js";
import { listStalledCrawlRuns } from "../src/db/crawl-run-repository.js";
import { seedDataQualityRemediationQueue } from "../src/db/data-quality-remediation-queue-repository.js";
import { deleteInactiveOfferSql } from "../src/db/product-search-entity-sql.js";
import { auditInactiveSearchMemberships } from "../src/db/product-search-membership-audit.js";
import { accountReads } from "../src/db/read-accounting.js";
import { AT, database } from "./helpers/d1-write-budget.js";

test("scoped deletion and empty recovery stay bounded with stale statistics and growing history", async () => {
  const { db, dispose } = await database();
  try {
    let previous = 0;
    const costs = [];
    for (const size of [100, 1_000, 10_000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,is_active)
        SELECT i,'budget',CAST(i AS TEXT),'unknown','https://example.test/'||i,'${AT}','${AT}','${AT}',
          CASE WHEN i<=95 THEN 1 ELSE 0 END FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id)
        SELECT id,'l-'||id,'unresolved_listing',id FROM products WHERE id>?`)
        .bind(previous)
        .run();
      if (!previous) {
        await db
          .prepare(
            "INSERT INTO product_search_entity_offers SELECT id,id,shop_key FROM products WHERE id<=40",
          )
          .run();
        await db.prepare("ANALYZE").run();
        await db.prepare("UPDATE products SET is_active=0 WHERE id>40").run();
      }
      await db
        .prepare(`INSERT INTO product_search_entity_offers SELECT id,id,shop_key FROM products
        WHERE id>? AND id>40`)
        .bind(previous)
        .run();
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO crawl_runs(shop_key,started_at,status) SELECT 'budget','2026-09-01T00:00:00Z','success' FROM n`)
        .bind(previous + 1, size)
        .run();
      for (const batch of [1, 2, 9, 40]) {
        const ids = Array.from({ length: batch }, (_, i) => i + 1);
        const measured = accountReads(db);
        await measured.db.batch(
          ids.map((id) => measured.db.prepare(deleteInactiveOfferSql()).bind(id)),
        );
        assert.equal(measured.rowsWritten(), 0);
        assert.ok(
          measured.rowsRead() <= 2 * batch,
          JSON.stringify({ size, batch, reads: measured.rowsRead() }),
        );
        assert.equal(measured.statementCount(), batch);
        costs.push({
          size,
          batch,
          reads: measured.rowsRead(),
          statements: measured.statementCount(),
        });
      }
      const recovery = accountReads(db);
      assert.deepEqual(
        await listStalledCrawlRuns(recovery.db, { startedBefore: AT, limit: 5 }),
        [],
      );
      assert.ok(recovery.rowsRead() <= 2);
      assert.equal(recovery.rowsWritten(), 0);
      // The normal empty cleanup must ignore even retained invalid memberships when no changes
      // are pending. Their detection belongs to the separately scheduled legacy audit.
      await db.prepare("DELETE FROM listing_projection_pending").run();
      const cleanup = accountReads(db);
      const empty = await claimShopMembershipCleanupChunk(cleanup.db, "budget", "", 50);
      assert.deepEqual(empty.sourceIds, []);
      assert.equal(empty.scannedCount, 0);
      assert.ok(cleanup.rowsRead() <= 3);
      const audit = accountReads(db);
      const window = await auditInactiveSearchMemberships(audit.db, { scanLimit: 5 });
      assert.equal(window.scannedCount, 5);
      assert.equal(window.repairedCount, 0);
      assert.ok(audit.rowsRead() <= 22);
      assert.ok(audit.rowsWritten() <= 1);
      previous = size;
    }
    const changed: D1Result[] = await db.batch(
      [40, 41, 42].map((id) => db.prepare(deleteInactiveOfferSql()).bind(id)),
    );
    assert.equal(
      changed.reduce((n, row) => n + row.meta.changes, 0),
      2,
    );
    const retained = await db
      .prepare(
        "SELECT listing_product_id FROM product_search_entity_offers WHERE listing_product_id IN (40,41,42,43) ORDER BY listing_product_id",
      )
      .all();
    assert.deepEqual(
      retained.results.map((row: { listing_product_id: number }) => row.listing_product_id),
      [40, 43],
    );
    console.log(JSON.stringify({ event: "maintenance_delete_read_budget", costs }));
  } finally {
    await dispose();
  }
}, 60_000);

test("already queued candidates and other shops' pending work have bounded scan windows", async () => {
  const { db, dispose } = await database();
  try {
    let previous = 0;
    const costs = [];
    for (const size of [100, 1_000, 10_000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,
          manufacturer_resolver_version,model_resolver_version,metadata_json)
        SELECT i,'other',CAST(i AS TEXT),'unknown','https://example.test/'||i,'${AT}','${AT}','${AT}',
          1,${RESOLUTION_VERSIONS.model},'${JSON.stringify({ categoryClassification: { version: RESOLUTION_VERSIONS.category } })}' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`INSERT INTO data_quality_remediation_queue(work_key,work_type,listing_product_id,
          entity_id,reason,available_at,created_at,updated_at)
        SELECT 'auto:resolve_manufacturer:listing:'||id||':manufacturer:1:model:${RESOLUTION_VERSIONS.model}:category:${RESOLUTION_VERSIONS.category}:identity:0',
          'resolve_manufacturer',id,CAST(id AS TEXT),'budget','${AT}','${AT}','${AT}' FROM products WHERE id>?`)
        .bind(previous)
        .run();
      await db.prepare("DELETE FROM data_quality_remediation_seed_cursors").run();
      const seed = accountReads(db);
      const seeded = await seedDataQualityRemediationQueue(seed.db, { limit: 10, now: AT });
      assert.equal(seeded.selectedCount, 0);
      assert.equal(seeded.scannedCount, 10);
      assert.ok(seed.rowsRead() < 250, `${size}: seed read ${seed.rowsRead()}`);
      assert.ok(seed.rowsWritten() <= 2, "only constant-size cursor state may change");
      const cleanup = accountReads(db);
      const window = await claimShopMembershipCleanupChunk(cleanup.db, "target", "", 10);
      assert.equal(window.scannedCount, 10);
      assert.equal(window.exhausted, false);
      assert.equal(window.afterSourceId, "pending:10");
      assert.deepEqual(window.sourceIds, []);
      assert.ok(cleanup.rowsRead() < 70);
      assert.equal(cleanup.rowsWritten(), 0);
      costs.push({
        size,
        seedReads: seed.rowsRead(),
        seedWrites: seed.rowsWritten(),
        cleanupReads: cleanup.rowsRead(),
      });
      previous = size;
    }
    assert.ok(costs[2].seedReads <= costs[0].seedReads + 10, JSON.stringify(costs));
    console.log(JSON.stringify({ event: "maintenance_candidate_read_budget", costs }));
    // Identity's driving index includes inactive listings. Their exclusion must happen after
    // the window is bounded, and they must never become remediation jobs.
    await db
      .prepare(`UPDATE products SET is_active=0,manufacturer_resolver_version=${RESOLUTION_VERSIONS.manufacturer};
      INSERT INTO product_identity_resolutions(listing_product_id,status,match_method,confidence,evaluated_at,identity_resolver_version)
      SELECT id,'unresolved','unresolved','none','${AT}',1 FROM products;
      UPDATE products SET is_active=1 WHERE id=10000;
      DELETE FROM data_quality_remediation_seed_cursors`)
      .run();
    const identities = accountReads(db);
    const identitySeed = await seedDataQualityRemediationQueue(identities.db, {
      limit: 10,
      now: AT,
    });
    assert.equal(identitySeed.selectedCount, 0);
    assert.equal(identitySeed.scannedCount, 10);
    assert.ok(
      identities.rowsRead() < 250,
      `inactive identity prefix read ${identities.rowsRead()}`,
    );
  } finally {
    await dispose();
  }
}, 60_000);
