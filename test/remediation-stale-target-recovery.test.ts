import assert from "node:assert/strict";
import test from "node:test";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import {
  claimDataQualityRemediationBatch,
  enqueueDataQualityRemediation,
  resolveDataQualityRemediationJob,
  seedDataQualityRemediationQueue,
} from "../src/db/data-quality-remediation-queue-repository.js";
import { enqueueStaleTargetReplayRecovery } from "../scripts/lib/remediation-stale-target-recovery.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

function insertListingAtCurrentVersions(): ReturnType<typeof migratedSqlite> {
  const migrated = migratedSqlite();
  const { sqlite } = migrated;
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
      RESOLUTION_VERSIONS.manufacturer,
      RESOLUTION_VERSIONS.model,
    );
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions(
        listing_product_id, status, match_method, confidence, evaluated_at, identity_resolver_version
      ) VALUES (1, 'matched', 'test', 'high', '2026-08-16T00:00:00.000Z', ?)
    `)
    .run(RESOLUTION_VERSIONS.identity);
  return migrated;
}

test("target-aware drain recovery can replay stale work blocked by a historical auto key", async () => {
  const { sqlite, db } = insertListingAtCurrentVersions();
  const staleManufacturerVersion = RESOLUTION_VERSIONS.manufacturer - 1;
  sqlite
    .prepare("UPDATE products SET manufacturer_resolver_version = ? WHERE id = 1")
    .run(staleManufacturerVersion);

  const legacyWorkKey = [
    "auto",
    "resolve_manufacturer",
    "listing:1",
    `manufacturer:${staleManufacturerVersion}`,
    `model:${RESOLUTION_VERSIONS.model}`,
    `category:${RESOLUTION_VERSIONS.category}`,
    `identity:${RESOLUTION_VERSIONS.identity}`,
  ].join(":");
  const now = "2026-08-16T00:01:00.000Z";
  assert.equal(
    await enqueueDataQualityRemediation(db, {
      workKey: legacyWorkKey,
      workType: "resolve_manufacturer",
      listingProductId: 1,
      entityId: "1",
      reason: "historical automatic replay",
      source: "scheduled_sweep",
      now,
    }),
    true,
  );
  const [historical] = await claimDataQualityRemediationBatch(db, { claimedAt: now, limit: 1 });
  assert.ok(historical);
  await resolveDataQualityRemediationJob(db, historical.id, now);

  const normal = await seedDataQualityRemediationQueue(db, {
    now: "2026-08-16T00:02:00.000Z",
  });
  assert.equal(normal.workKeys.length, 0, "the legacy key reproduces the production seeding block");

  const recovery = await enqueueStaleTargetReplayRecovery(db, {
    now: "2026-08-16T00:02:00.000Z",
  });
  assert.equal(recovery.selectedCount, 1);
  assert.equal(recovery.workKeys.length, 1);
  assert.match(recovery.workKeys[0] || "", /drain-stale-target-v1/);
  assert.match(
    recovery.workKeys[0] || "",
    new RegExp(`manufacturer:${RESOLUTION_VERSIONS.manufacturer}`),
  );

  const duplicate = await enqueueStaleTargetReplayRecovery(db, {
    now: "2026-08-16T00:03:00.000Z",
  });
  assert.equal(duplicate.workKeys.length, 0, "the target generation must remain idempotent");

  const [recoveryJob] = await claimDataQualityRemediationBatch(db, {
    claimedAt: "2026-08-16T00:03:00.000Z",
    limit: 1,
  });
  assert.ok(recoveryJob);
  assert.equal(recoveryJob.workType, "reprocess_listing");
  assert.equal(recoveryJob.listingProductId, 1);
});
