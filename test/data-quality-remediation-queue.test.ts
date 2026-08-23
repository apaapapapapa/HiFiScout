import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
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
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

/**
 * These tests ran against a hand-written three-column schema until the staleness selector was split
 * into one indexed query per stage. Those queries name their index with `INDEXED BY`, so a schema
 * that omits an index no longer produces a slower plan — it produces no plan at all. Replaying the
 * real migrations is therefore the only honest fixture, and it removes a copy of the products DDL
 * that had to be kept in step with every index the repository depends on.
 */
function database() {
  return migratedSqlite();
}

/** The columns `products` requires, with everything the staleness selectors look at already good. */
function insertHealthyListing(sqlite: DatabaseSync, id: number): void {
  sqlite
    .prepare(`
      INSERT INTO products(
        id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
        last_activity_at, is_active, metadata_json,
        manufacturer_resolver_version, model_resolver_version,
        manufacturer_resolution_status, model_resolution_status, classification_status
      ) VALUES (
        ?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1, ?,
        ?, ?, 'resolved', 'resolved', 'classified'
      )
    `)
    .run(
      id,
      `shop-${id}`,
      `source-${id}`,
      `listing ${id}`,
      `https://example.test/${id}`,
      JSON.stringify({ categoryClassification: { version: RESOLUTION_VERSIONS.category } }),
      RESOLUTION_VERSIONS.manufacturer,
      RESOLUTION_VERSIONS.model,
    );
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions(
        listing_product_id, status, match_method, confidence, evaluated_at, identity_resolver_version
      ) VALUES (?, 'matched', 'test', 'high', '2026-07-01T00:00:00.000Z', ?)
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

test("a listing that is merely unresolved at the current version is not stale", async () => {
  // Being unresolved is a result, not a signal. Replaying the same resolver version over the same
  // listing produces the same answer, so seeding it every five minutes only re-enqueues work whose
  // outcome is already known — and once its deterministic key is queued, walking the whole
  // persistent unresolved set to find nothing is the cost that has to stay off the cron path.
  // Outcomes change when a version moves (covered above) or when a dependency does, and every
  // dependency drives its own bounded replay; `enqueueFullDataQualityRebuild` remains for the rest.
  const { sqlite, db } = database();
  insertHealthyListing(sqlite, 1);
  sqlite.exec(`
    UPDATE products
    SET manufacturer_resolution_status = 'unresolved',
        model_resolution_status = 'unresolved',
        classification_status = 'unclassified'
    WHERE id = 1
  `);
  sqlite.exec(
    "UPDATE product_identity_resolutions SET status = 'unresolved' WHERE listing_product_id = 1",
  );

  const seeded = await seedDataQualityRemediationQueue(db, { now: "2026-08-15T00:00:00.000Z" });

  assert.equal(seeded.selectedCount, 0);
  assert.deepEqual(seeded.workKeys, []);
});

test("a listing whose downstream refresh failed is still stale", async () => {
  // The counterpart: `remediation_projection_required` is a signal, and it is what keeps a listing
  // that is already at every current version from being stranded by a failed projection pass.
  const { sqlite, db } = database();
  insertHealthyListing(sqlite, 1);
  sqlite.exec("UPDATE products SET remediation_projection_required = 1 WHERE id = 1");

  const seeded = await seedDataQualityRemediationQueue(db, { now: "2026-08-15T00:00:00.000Z" });

  assert.equal(seeded.workKeys.length, 1);
  assert.match(seeded.workKeys[0] || "", /rebuild_search_entity/);
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
  const { sqlite, db } = database();
  // The queue carries a foreign key to `products`, so the listing this job points at has to exist.
  insertHealthyListing(sqlite, 42);
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
