import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import {
  claimDataQualityRemediationBatch,
  dataQualityRemediationQueueMetrics,
  enqueueDataQualityRemediation,
  enqueueFullDataQualityRebuild,
  resolveDataQualityRemediationJob,
  retryOrFailDataQualityRemediationJob,
  seedDataQualityRemediationQueue,
} from "../src/db/data-quality-remediation-queue-repository.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      is_active INTEGER NOT NULL DEFAULT 1,
      manufacturer_resolver_version INTEGER NOT NULL,
      model_resolver_version INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      remediation_projection_required INTEGER NOT NULL DEFAULT 0,
      manufacturer_resolution_status TEXT NOT NULL DEFAULT 'resolved',
      model_resolution_status TEXT NOT NULL DEFAULT 'resolved',
      classification_status TEXT NOT NULL DEFAULT 'classified'
    );
    CREATE TABLE product_identity_resolutions (
      listing_product_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      identity_resolver_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE data_quality_remediation_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_key TEXT NOT NULL UNIQUE,
      work_type TEXT NOT NULL,
      listing_product_id INTEGER,
      entity_id TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 100,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      lease_expires_at TEXT,
      resolved_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return { sqlite, db: sqliteD1(sqlite) };
}

function insertHealthyListing(sqlite: DatabaseSync, id: number): void {
  sqlite
    .prepare(`
      INSERT INTO products(
        id, manufacturer_resolver_version, model_resolver_version, metadata_json,
        manufacturer_resolution_status, model_resolution_status, classification_status
      ) VALUES (?, ?, ?, ?, 'resolved', 'resolved', 'classified')
    `)
    .run(
      id,
      RESOLUTION_VERSIONS.manufacturer,
      RESOLUTION_VERSIONS.model,
      JSON.stringify({ categoryClassification: { version: RESOLUTION_VERSIONS.category } }),
    );
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions(listing_product_id, status, identity_resolver_version)
      VALUES (?, 'matched', ?)
    `)
    .run(id, RESOLUTION_VERSIONS.identity);
}

test("stale resolver work is seeded once with a deterministic key", async () => {
  const { sqlite, db } = database();
  insertHealthyListing(sqlite, 1);
  sqlite
    .prepare("UPDATE products SET manufacturer_resolver_version = ? WHERE id = 1")
    .run(RESOLUTION_VERSIONS.manufacturer - 1);
  const now = "2026-08-15T00:00:00.000Z";

  const first = await seedDataQualityRemediationQueue(db, { now });
  const second = await seedDataQualityRemediationQueue(db, { now });

  assert.equal(first.selectedCount, 1);
  assert.equal(first.workKeys.length, 1);
  assert.match(first.workKeys[0] || "", /resolve_manufacturer/);
  assert.equal(second.selectedCount, 0);
  assert.equal(second.workKeys.length, 0, "same stale evidence/version must not duplicate work");

  const [job] = await claimDataQualityRemediationBatch(db, { claimedAt: now, limit: 1 });
  assert.ok(job);
  assert.equal(job.workType, "resolve_manufacturer");
  assert.equal(job.attemptCount, 1);
  await resolveDataQualityRemediationJob(db, job.id, now);
  const metrics = await dataQualityRemediationQueueMetrics(db);
  assert.equal(metrics.backlog, 0);
  assert.equal(metrics.resolved, 1);
});

test("a listing already at every current version seeds no work at all", async () => {
  // The counterpart to the staleness selectors: if the version predicates ever stopped filtering,
  // every sweep would re-enqueue the whole table and the queue would never drain. Nothing else
  // asserts the empty case, because every other seeding test starts by making a row stale.
  const { sqlite, db } = database();
  insertHealthyListing(sqlite, 1);
  insertHealthyListing(sqlite, 2);

  const seeded = await seedDataQualityRemediationQueue(db, { now: "2026-08-15T00:00:00.000Z" });

  assert.equal(seeded.selectedCount, 0);
  assert.deepEqual(seeded.workKeys, []);
  const metrics = await dataQualityRemediationQueueMetrics(db);
  assert.equal(metrics.backlog, 0);
});

test("deduplicated low ids cannot starve later stale listings", async () => {
  const { sqlite, db } = database();
  insertHealthyListing(sqlite, 1);
  insertHealthyListing(sqlite, 2);
  sqlite
    .prepare("UPDATE products SET manufacturer_resolver_version = ?")
    .run(RESOLUTION_VERSIONS.manufacturer - 1);
  const now = "2026-08-15T00:00:00.000Z";

  const first = await seedDataQualityRemediationQueue(db, { now, limit: 1 });
  const second = await seedDataQualityRemediationQueue(db, { now, limit: 1 });
  const third = await seedDataQualityRemediationQueue(db, { now, limit: 1 });

  assert.equal(first.workKeys.length, 1);
  assert.match(first.workKeys[0] || "", /listing:1:/);
  assert.equal(second.workKeys.length, 1);
  assert.match(second.workKeys[0] || "", /listing:2:/);
  assert.equal(third.selectedCount, 0);
  assert.equal(third.workKeys.length, 0);
});

test("abandoned processing is reclaimable and retry exhaustion becomes failed", async () => {
  const { db } = database();
  const t0 = "2026-08-15T00:00:00.000Z";
  await enqueueDataQualityRemediation(db, {
    workKey: "manual:listing:42",
    workType: "reprocess_listing",
    listingProductId: 42,
    reason: "test",
    maxAttempts: 2,
    now: t0,
  });

  const [first] = await claimDataQualityRemediationBatch(db, {
    claimedAt: t0,
    leaseSeconds: 60,
  });
  assert.ok(first);
  assert.equal(first.attemptCount, 1);

  const [reclaimed] = await claimDataQualityRemediationBatch(db, {
    claimedAt: "2026-08-15T00:01:01.000Z",
    leaseSeconds: 60,
  });
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, first.id);
  assert.equal(reclaimed.attemptCount, 2);

  const status = await retryOrFailDataQualityRemediationJob(db, reclaimed.id, "boom", {
    updatedAt: "2026-08-15T00:01:02.000Z",
  });
  assert.equal(status, "failed");
  const metrics = await dataQualityRemediationQueueMetrics(db);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.backlog, 0);
});

test("full rebuild is explicit, bounded, restartable, and idempotent by rebuild key", async () => {
  const { sqlite, db } = database();
  insertHealthyListing(sqlite, 1);
  insertHealthyListing(sqlite, 2);
  insertHealthyListing(sqlite, 3);
  const options = {
    limit: 2,
    rebuildKey: "recovery-2026-08-15",
    now: "2026-08-15T00:00:00.000Z",
  } as const;

  const page1 = await enqueueFullDataQualityRebuild(db, options);
  assert.equal(page1.selectedCount, 2);
  assert.equal(page1.workKeys.length, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextAfterId, 2);

  const duplicate = await enqueueFullDataQualityRebuild(db, options);
  assert.equal(duplicate.workKeys.length, 0);

  const page2 = await enqueueFullDataQualityRebuild(db, {
    ...options,
    afterId: page1.nextAfterId || 0,
  });
  assert.equal(page2.selectedCount, 1);
  assert.equal(page2.workKeys.length, 1);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.nextAfterId, null);
});
