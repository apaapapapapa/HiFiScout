import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import {
  remediationNeedsDataQualitySnapshot,
  runDataQualityRemediationSweep,
} from "../src/db/data-quality-remediation-service.js";
import { enqueueDataQualityRemediation } from "../src/db/data-quality-remediation-queue-repository.js";
import { saveDataQualityRun } from "../src/db/data-quality-repository.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { AT, database, listing } from "./helpers/d1-write-budget.js";

const MIGRATION = "0127_data_quality_snapshot_coverage.sql";
const AFTER = "2026-09-14T10:00:00.000Z";

/** Interleave a failure or another writer after the aggregate, before its durable snapshot. */
function beforeSnapshotWrite(db: QueryableDatabase, hook: () => Promise<void>): QueryableDatabase {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "run") {
          return async () => {
            await hook();
            return target.run();
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return /INSERT INTO data_quality_runs\(/.test(sql) ? wrap(statement) : statement;
    },
    batch: db.batch.bind(db),
  };
}

test("metadata-only sweep recovers a failed crawl snapshot with no remediation event", async () => {
  const { db, dispose } = await database();
  try {
    await upsertProducts(db, "budget", [listing("recovery")], AT);
    await refreshListingProjections(db, [{ shop_key: "budget", source_id: "recovery" }], AT);
    await saveDataQualityRun(db, { shopKey: "budget", evaluatedAt: AT });
    await db.prepare("DELETE FROM data_quality_remediation_events").run();
    await db
      .prepare("UPDATE products SET stock_status = 'unknown' WHERE shop_key = 'budget'")
      .run();

    const failing = beforeSnapshotWrite(db, async () => {
      throw new Error("transient snapshot INSERT failure");
    });
    await assert.rejects(
      saveDataQualityRun(failing, { shopKey: "budget", evaluatedAt: AT }),
      /transient snapshot INSERT failure/,
    );
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), true);
    assert.equal(
      await db.prepare("SELECT COUNT(*) AS n FROM data_quality_remediation_events").first("n"),
      0,
    );

    const id = Number(
      await db.prepare("SELECT id FROM products WHERE source_id = 'recovery'").first("id"),
    );
    await db
      .prepare(
        "UPDATE products SET metadata_json = json_set(metadata_json, '$.categoryClassification.version', ?) WHERE id = ?",
      )
      .bind(RESOLUTION_VERSIONS.category - 1, id)
      .run();
    await enqueueDataQualityRemediation(db, {
      workKey: "snapshot-recovery",
      workType: "classify_category",
      listingProductId: id,
      source: "manual",
      reason: "recover quality after failed crawl persistence",
      now: AT,
    });
    const options = { claimLimit: 1, preferQueuedWork: true, measureQueue: false as const };
    const failed = await runDataQualityRemediationSweep(failing, {
      ...options,
      now: new Date(AFTER),
    });
    assert.equal(failed.resolved, 0);
    assert.equal(failed.retried, 1);
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), true);
    const recovered = await runDataQualityRemediationSweep(db, {
      ...options,
      now: new Date("2026-09-14T11:00:00.000Z"),
    });
    assert.equal(recovered.resolved, 1);
    assert.equal(recovered.snapshotsSkipped, 0);
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), false);
    const snapshot = await db
      .prepare(
        "SELECT inventory_unknown_count, crawl_run_id FROM data_quality_runs ORDER BY id DESC LIMIT 1",
      )
      .first();
    assert.deepEqual(snapshot, { inventory_unknown_count: 1, crawl_run_id: null });
  } finally {
    await dispose();
  }
}, 30_000);

test("concurrent mutation and an out-of-order snapshot cannot clear newer coverage", async () => {
  const { db, dispose } = await database();
  try {
    await upsertProducts(db, "budget", [listing("concurrent")], AT);
    const delayed = beforeSnapshotWrite(db, async () => {
      await db
        .prepare("UPDATE products SET stock_status = 'unknown' WHERE shop_key = 'budget'")
        .run();
      await saveDataQualityRun(db, { shopKey: "budget", evaluatedAt: AT });
    });
    await saveDataQualityRun(delayed, { shopKey: "budget", evaluatedAt: AFTER });
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), true);
    const repaired = await saveDataQualityRun(db, { shopKey: "budget", evaluatedAt: AFTER });
    assert.equal(repaired.counts.inventoryUnknownCount, 1);
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), false);
  } finally {
    await dispose();
  }
}, 30_000);

test("legacy snapshots and old-writer updates never inherit unproven coverage", async () => {
  const { db, dispose } = await database({ before: MIGRATION });
  try {
    await upsertProducts(db, "budget", [listing("legacy")], AT);
    // Old code inserts no source_revision, including when a failed snapshot left older metrics.
    await db
      .prepare(`INSERT INTO data_quality_runs(shop_key, evaluated_at,
      manufacturer_status, category_status, identity_status, inventory_status, model_status,
      parser_status, item_count_status, evidence_status, snapshot_status, run_status, quality_status)
      VALUES ('budget', ?, 'unknown', 'unknown', 'unknown', 'unknown', 'unknown',
        'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown')`)
      .bind(AT)
      .run();
    const { migrationSources } = await import("./helpers/migrations.js");
    const migration = migrationSources.find((entry) => entry.name === MIGRATION)!;
    await db.prepare(migration.sql).run();
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), true);
    await saveDataQualityRun(db, { shopKey: "budget", evaluatedAt: AFTER });
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), false);
    await db
      .prepare("UPDATE data_quality_runs SET total_items = 0 WHERE source_revision IS NOT NULL")
      .run();
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), true);
    await saveDataQualityRun(db, { shopKey: "budget", evaluatedAt: AFTER });
    await db.prepare("DELETE FROM data_quality_snapshot_state").run();
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), true);
  } finally {
    await dispose();
  }
}, 30_000);

test("all quality-input transitions invalidate coverage, while metadata and inactive edits do not", async () => {
  const { db, dispose } = await database();
  try {
    await upsertProducts(db, "budget", [listing("inputs")], AT);
    await saveDataQualityRun(db, { shopKey: "budget", evaluatedAt: AFTER });
    const changes = [
      "UPDATE products SET raw_manufacturer = ''",
      "UPDATE products SET manufacturer_resolution_status = 'unresolved'",
      "UPDATE products SET classification_status = 'classified'",
      "UPDATE products SET primary_category_id = 'other'",
      "UPDATE products SET stock_status = 'unknown'",
      "UPDATE products SET model_resolution_status = 'unresolved'",
      "INSERT INTO product_identity_resolutions(listing_product_id,status,match_method,confidence,evaluated_at) SELECT id,'unresolved','none','none','' FROM products",
      "UPDATE product_identity_resolutions SET match_method = 'vetoed'",
      "UPDATE product_identity_resolutions SET status = 'matched'",
      "DELETE FROM product_identity_resolutions",
      "UPDATE products SET is_active = 0",
    ];
    for (const sql of changes) {
      await db.prepare(sql).run();
      assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), true, sql);
      await saveDataQualityRun(db, { shopKey: "budget", evaluatedAt: AFTER });
      assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), false, sql);
    }
    await db
      .prepare(
        "UPDATE products SET stock_status = 'in_stock', metadata_json = '{}', model_resolver_version = 999",
      )
      .run();
    assert.equal(
      await remediationNeedsDataQualitySnapshot(db, "budget"),
      false,
      "inactive changes do not enter the aggregate",
    );
    await db.prepare("UPDATE products SET is_active = 1").run();
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), true);
    await saveDataQualityRun(db, { shopKey: "budget", evaluatedAt: AFTER });
    await db
      .prepare(
        "UPDATE products SET stock_status = stock_status, last_seen_at = 'later', metadata_json = '{\"version\":999}'",
      )
      .run();
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), false);
    await saveDataQualityRun(db, { shopKey: "other-shop", evaluatedAt: AFTER });
    await db.prepare("UPDATE products SET shop_key = 'other-shop'").run();
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "budget"), true);
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "other-shop"), true);
    await saveDataQualityRun(db, { shopKey: "other-shop", evaluatedAt: AFTER });
    await db.prepare("DELETE FROM products").run();
    assert.equal(await remediationNeedsDataQualitySnapshot(db, "other-shop"), true);
  } finally {
    await dispose();
  }
}, 30_000);

for (const size of [100, 1_000]) {
  test(`quality coverage coalesces ${size} listing mutations into one extra D1 write`, async () => {
    const before = await database({ before: MIGRATION });
    const after = await database();
    try {
      const metrics = [];
      for (const { db } of [before, after]) {
        await db
          .prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id < ?)
          INSERT INTO products(shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at)
          SELECT 'budget',id,'Test','https://example.test/','','','' FROM n`)
          .bind(size)
          .run();
        if (db === after.db)
          await saveDataQualityRun(db, { shopKey: "budget", evaluatedAt: AFTER });
        const measured = accountReads(db);
        await measured.db
          .prepare(
            "UPDATE products SET manufacturer_resolution_status = 'resolved' WHERE shop_key = 'budget'",
          )
          .run();
        metrics.push({
          reads: measured.rowsRead(),
          writes: measured.rowsWritten(),
          statements: measured.countedStatements(),
        });
      }
      assert.equal(metrics[1].writes - metrics[0].writes, 1);
      assert.equal(metrics[1].statements, metrics[0].statements);
      assert.ok(metrics[1].reads - metrics[0].reads <= size * 2 + 2);
      assert.equal(await remediationNeedsDataQualitySnapshot(after.db, "budget"), true);
      const probe = accountReads(after.db);
      await remediationNeedsDataQualitySnapshot(probe.db, "budget");
      assert.ok(probe.rowsRead() <= 4, `coverage probe read ${probe.rowsRead()} rows`);
      console.log(
        JSON.stringify({
          event: "quality_snapshot_coverage_budget",
          listings: size,
          before: metrics[0],
          after: metrics[1],
          probeReads: probe.rowsRead(),
        }),
      );
    } finally {
      await before.dispose();
      await after.dispose();
    }
  }, 30_000);
}
