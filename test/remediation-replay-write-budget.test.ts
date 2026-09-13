import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import {
  replayAdminCsvListings,
  runDataQualityRemediationSweep,
} from "../src/db/data-quality-remediation-service.js";
import { saveDataQualityRun } from "../src/db/data-quality-repository.js";
import { enqueueDataQualityRemediation } from "../src/db/data-quality-remediation-queue-repository.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { accountReads } from "../src/db/read-accounting.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { AT, database, listing } from "./helpers/d1-write-budget.js";

test("metadata-only remediation does not rewrite unrelated listing indexes or categories", async () => {
  const { db, dispose } = await database();
  try {
    const product = listing("metadata-only");
    await upsertProducts(db, "budget", [product], AT);
    await refreshListingProjections(db, [{ shop_key: "budget", source_id: product.sourceId }], AT);
    const id = Number(
      await db
        .prepare("SELECT id FROM products WHERE shop_key = ? AND source_id = ?")
        .bind("budget", product.sourceId)
        .first("id"),
    );
    await db
      .prepare(
        "UPDATE products SET metadata_json = json_set(metadata_json, '$.categoryClassification.version', ?) WHERE id = ?",
      )
      .bind(RESOLUTION_VERSIONS.category - 1, id)
      .run();
    const beforeCategories = (
      await db
        .prepare(
          "SELECT category_id, is_direct FROM product_categories WHERE product_id = ? ORDER BY category_id",
        )
        .bind(id)
        .all()
    ).results;

    const measured = accountReads(db);
    await replayAdminCsvListings(measured.db, [id], "2026-09-12T09:00:00.000Z", []);

    assert.deepEqual(
      (
        await db
          .prepare(
            "SELECT category_id, is_direct FROM product_categories WHERE product_id = ? ORDER BY category_id",
          )
          .bind(id)
          .all()
      ).results,
      beforeCategories,
    );
    assert.ok(measured.rowsWritten() > 0);
    assert.ok(
      measured.rowsWritten() <= 4,
      `metadata-only replay wrote ${measured.rowsWritten()} rows`,
    );
    assert.ok(
      measured.rowsRead() <= 35,
      `metadata-only replay read ${measured.rowsRead()} rows without changing a projection`,
    );
    assert.equal(
      await db
        .prepare("SELECT remediation_projection_required FROM products WHERE id = ?")
        .bind(id)
        .first("remediation_projection_required"),
      0,
    );
    console.log(
      JSON.stringify({
        event: "remediation_metadata_only_write_budget",
        rowsRead: measured.rowsRead(),
        rowsWritten: measured.rowsWritten(),
        statements: measured.countedStatements(),
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("metadata-only sweep skips the shop-wide quality scan when the latest snapshot is authoritative", async () => {
  const { db, dispose } = await database();
  try {
    const product = listing("metadata-only-snapshot");
    await upsertProducts(db, "budget", [product], AT);
    await refreshListingProjections(db, [{ shop_key: "budget", source_id: product.sourceId }], AT);
    const id = Number(
      await db
        .prepare("SELECT id FROM products WHERE shop_key = ? AND source_id = ?")
        .bind("budget", product.sourceId)
        .first("id"),
    );
    await db
      .prepare(
        "WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<104000) INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,manufacturer_resolution_status,classification_status) SELECT id,'budget','quality-budget-'||id,'Other','https://example.test/','','','','resolved','classified' FROM n",
      )
      .run();
    await db
      .prepare(
        "WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<104000) INSERT INTO product_identity_resolutions(listing_product_id,status,match_method,confidence,evaluated_at) SELECT id,'unresolved','budget','none','2026-09-12T08:00:00.000Z' FROM n",
      )
      .run();
    await db
      .prepare(
        "UPDATE products SET metadata_json = json_set(metadata_json, '$.categoryClassification.version', ?) WHERE id = ?",
      )
      .bind(RESOLUTION_VERSIONS.category - 1, id)
      .run();
    await saveDataQualityRun(db, {
      shopKey: "budget",
      evaluatedAt: "2026-09-12T08:50:00.000Z",
    });
    await enqueueDataQualityRemediation(db, {
      workKey: `metadata-only-snapshot:${id}`,
      workType: "classify_category",
      listingProductId: id,
      source: "manual",
      reason: "measure unchanged snapshot",
      now: "2026-09-12T08:55:00.000Z",
    });

    const fullScan = accountReads(db);
    await saveDataQualityRun(fullScan.db, {
      shopKey: "budget",
      evaluatedAt: "2026-09-12T08:59:00.000Z",
    });
    const optimized = accountReads(db);
    const result = await runDataQualityRemediationSweep(optimized.db, {
      seedLimit: 1,
      claimLimit: 1,
      now: new Date("2026-09-12T09:00:00.000Z"),
      preferQueuedWork: true,
      measureQueue: false,
    });

    assert.equal(result.resolved, 1);
    assert.equal(result.snapshotsSkipped, 1);
    assert.ok(fullScan.rowsRead() >= 4_000, `full snapshot read ${fullScan.rowsRead()} rows`);
    assert.ok(
      optimized.rowsRead() < fullScan.rowsRead() / 10,
      `optimized sweep read ${optimized.rowsRead()} rows after ${fullScan.rowsRead()}-row snapshot`,
    );
    console.log(
      JSON.stringify({
        event: "remediation_unchanged_snapshot_read_budget",
        beforeRowsRead: fullScan.rowsRead(),
        afterRowsRead: optimized.rowsRead(),
        afterRowsWritten: optimized.rowsWritten(),
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("metadata-only remediation still finishes a projection marker owned by an older writer", async () => {
  const { db, dispose } = await database();
  try {
    const product = listing("metadata-only-pending");
    await upsertProducts(db, "budget", [product], AT);
    await refreshListingProjections(db, [{ shop_key: "budget", source_id: product.sourceId }], AT);
    const id = Number(
      await db
        .prepare("SELECT id FROM products WHERE shop_key = ? AND source_id = ?")
        .bind("budget", product.sourceId)
        .first("id"),
    );
    await db
      .prepare(`UPDATE products
        SET metadata_json = json_set(metadata_json, '$.categoryClassification.version', ?),
            remediation_projection_required = 1,
            remediation_projection_token = 'older-writer'
        WHERE id = ?`)
      .bind(RESOLUTION_VERSIONS.category - 1, id)
      .run();
    await db.prepare("DELETE FROM product_search_projection WHERE product_id = ?").bind(id).run();

    await replayAdminCsvListings(db, [id], "2026-09-12T09:00:00.000Z", []);

    assert.ok(
      await db
        .prepare("SELECT product_id FROM product_search_projection WHERE product_id = ?")
        .bind(id)
        .first(),
    );
    assert.deepEqual(
      await db
        .prepare(
          "SELECT remediation_projection_required AS pending, remediation_projection_token AS token FROM products WHERE id = ?",
        )
        .bind(id)
        .first(),
      { pending: 0, token: "" },
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("an explicit catalog identity edit can force projection without listing-derived changes", async () => {
  const { db, dispose } = await database();
  try {
    const product = listing("catalog-identity-change");
    await upsertProducts(db, "budget", [product], AT);
    await refreshListingProjections(db, [{ shop_key: "budget", source_id: product.sourceId }], AT);
    const id = Number(
      await db
        .prepare("SELECT id FROM products WHERE shop_key = ? AND source_id = ?")
        .bind("budget", product.sourceId)
        .first("id"),
    );
    await db.prepare("DELETE FROM product_search_projection WHERE product_id = ?").bind(id).run();

    await replayAdminCsvListings(db, [id], "2026-09-12T09:00:00.000Z", [], {
      forceProjection: true,
    });

    assert.ok(
      await db
        .prepare("SELECT product_id FROM product_search_projection WHERE product_id = ?")
        .bind(id)
        .first(),
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("an explicit full rebuild repairs projection without listing-derived changes", async () => {
  const { db, dispose } = await database();
  try {
    const product = listing("full-rebuild");
    await upsertProducts(db, "budget", [product], AT);
    await refreshListingProjections(db, [{ shop_key: "budget", source_id: product.sourceId }], AT);
    const id = Number(
      await db
        .prepare("SELECT id FROM products WHERE shop_key = ? AND source_id = ?")
        .bind("budget", product.sourceId)
        .first("id"),
    );
    await db.prepare("DELETE FROM product_search_projection WHERE product_id = ?").bind(id).run();
    await enqueueDataQualityRemediation(db, {
      workKey: `full:test:listing:${id}`,
      workType: "reprocess_listing",
      listingProductId: id,
      source: "manual",
      reason: "test full rebuild",
      now: AT,
    });

    const result = await runDataQualityRemediationSweep(db, {
      seedLimit: 1,
      claimLimit: 1,
      now: new Date("2026-09-12T09:00:00.000Z"),
      preferQueuedWork: true,
    });

    assert.equal(result.resolved, 1);
    assert.ok(
      await db
        .prepare("SELECT product_id FROM product_search_projection WHERE product_id = ?")
        .bind(id)
        .first(),
    );
  } finally {
    await dispose();
  }
}, 30_000);
