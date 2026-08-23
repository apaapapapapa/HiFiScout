import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import {
  claimDataQualityRemediationBatch,
  resolveDataQualityRemediationJob,
  seedDataQualityRemediationQueue,
} from "../src/db/data-quality-remediation-queue-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

function insertListing(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]): void {
  sqlite
    .prepare(`
      INSERT INTO products(
        id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
        last_activity_at, is_active, metadata_json,
        manufacturer_resolver_version, model_resolver_version,
        manufacturer_resolution_status, model_resolution_status, classification_status
      ) VALUES (
        1, 'shop', 'source-1', 'listing 1', 'https://example.test/1',
        '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z',
        '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', 1, ?,
        ?, ?, 'resolved', 'resolved', 'classified'
      )
    `)
    .run(
      JSON.stringify({ categoryClassification: { version: RESOLUTION_VERSIONS.category } }),
      RESOLUTION_VERSIONS.manufacturer - 1,
      RESOLUTION_VERSIONS.model,
    );
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions(
        listing_product_id, status, match_method, confidence, evaluated_at, identity_resolver_version
      ) VALUES (1, 'matched', 'test', 'high', '2026-08-16T00:00:00.000Z', ?)
    `)
    .run(RESOLUTION_VERSIONS.identity);
}

test("resolved automatic work releases its canonical dedupe key for a later stale recurrence", async () => {
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite);
  const firstAt = "2026-08-16T00:01:00.000Z";

  const firstSeed = await seedDataQualityRemediationQueue(db, { now: firstAt, limit: 1 });
  assert.equal(firstSeed.workKeys.length, 1);
  const canonicalKey = firstSeed.workKeys[0] || "";
  assert.match(canonicalKey, /^auto:resolve_manufacturer:/);

  const [firstJob] = await claimDataQualityRemediationBatch(db, {
    claimedAt: firstAt,
    limit: 1,
  });
  assert.ok(firstJob);

  // Simulate the successful replay before the queue job is marked resolved.
  sqlite
    .prepare("UPDATE products SET manufacturer_resolver_version = ? WHERE id = 1")
    .run(RESOLUTION_VERSIONS.manufacturer);
  await resolveDataQualityRemediationJob(db, firstJob.id, firstAt);

  const archived = sqlite
    .prepare("SELECT work_key, status FROM data_quality_remediation_queue WHERE id = ?")
    .get(firstJob.id) as { work_key: string; status: string };
  assert.equal(archived.status, "resolved");
  assert.equal(archived.work_key, `${canonicalKey}:resolved:${firstJob.id}`);

  // A later crawler/write can make the same stored-version tuple stale again. The resolved history
  // must not reserve the active dedupe key forever.
  sqlite
    .prepare("UPDATE products SET manufacturer_resolver_version = ? WHERE id = 1")
    .run(RESOLUTION_VERSIONS.manufacturer - 1);

  const secondAt = "2026-08-16T00:02:00.000Z";
  const secondSeed = await seedDataQualityRemediationQueue(db, { now: secondAt, limit: 1 });
  assert.deepEqual(secondSeed.workKeys, [canonicalKey]);

  const duplicateWhilePending = await seedDataQualityRemediationQueue(db, {
    now: "2026-08-16T00:03:00.000Z",
    limit: 1,
  });
  assert.equal(
    duplicateWhilePending.workKeys.length,
    0,
    "the canonical key must still dedupe active work",
  );

  const rows = sqlite
    .prepare(`
      SELECT work_key, status
      FROM data_quality_remediation_queue
      ORDER BY id
    `)
    .all() as Array<{ work_key: string; status: string }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.work_key, `${canonicalKey}:resolved:${firstJob.id}`);
  assert.equal(rows[0]?.status, "resolved");
  assert.equal(rows[1]?.work_key, canonicalKey);
  assert.equal(rows[1]?.status, "pending");
});
