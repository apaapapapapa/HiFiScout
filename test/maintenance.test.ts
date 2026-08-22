import assert from "node:assert/strict";
import test from "node:test";
import { retentionCutoffs, runRetentionCleanup } from "../src/maintenance.js";
import { captureDatabase } from "./helpers/d1.js";

test("retention cutoffs use conservative operational defaults", () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const result = retentionCutoffs({}, now);

  assert.equal(result.settings.crawlRunRetentionDays, 30);
  assert.equal(result.settings.dataQualityRetentionDays, 180);
  assert.equal(result.settings.priceHistoryRetentionDays, 1095);
  assert.equal(result.settings.inactiveProductRetentionDays, 365);
  assert.equal(result.settings.deleteBatchSize, 500);
  assert.equal(result.crawlRunsBefore, "2026-07-12T00:00:00.000Z");
  assert.equal(result.dataQualityBefore, "2026-02-12T00:00:00.000Z");
  assert.equal(result.inactiveProductsBefore, "2025-08-11T00:00:00.000Z");
});

test("deleting an aged-out listing also retires the product it was the last offer for", async () => {
  const db = captureDatabase();
  const result = await runRetentionCleanup(
    { DB: db },
    { now: new Date("2026-08-11T00:00:00.000Z") },
  );

  const prune = db.calls.find((statement) =>
    /DELETE FROM product_search_entities/.test(statement.sql),
  );
  assert.ok(prune, "expected empty product entities to be pruned");
  assert.match(prune.sql, /NOT EXISTS[\s\S]*product_search_entity_offers/);
  assert.equal(result.deleted.emptySearchEntities, 1);
  // Order matters: pruning before the listing delete would leave the entity behind.
  const listingDelete = db.calls.findIndex((statement) =>
    /DELETE FROM products/.test(statement.sql),
  );
  assert.ok(listingDelete >= 0 && listingDelete < db.calls.indexOf(prune));
});

test("expired Product Audit exports are deleted in a bounded daily batch", async () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const db = captureDatabase();
  const result = await runRetentionCleanup({ DB: db }, { now });

  const cleanup = db.calls.find((statement) =>
    /DELETE FROM product_audit_export_jobs/.test(statement.sql),
  );
  assert.ok(cleanup);
  assert.match(cleanup.sql, /expires_at IS NOT NULL AND expires_at <= \?/);
  assert.match(cleanup.sql, /ORDER BY expires_at ASC, id ASC[\s\S]*LIMIT \?/);
  assert.deepEqual(cleanup.binds, [now.toISOString(), 500]);
  assert.equal(result.deleted.productAuditExports, 1);
});

test("retention delete batches are capped at 1000 rows", () => {
  const result = retentionCutoffs(
    { RETENTION_DELETE_BATCH_SIZE: "5000" },
    new Date("2026-08-11T00:00:00.000Z"),
  );
  assert.equal(result.settings.deleteBatchSize, 1000);
});
