import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { compactSupersededAutomaticRemediationJobs } from "../src/db/data-quality-remediation-compaction.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

interface QueueState {
  status: string;
  resolved_at: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
}

function state(sqlite: DatabaseSync, id: number): QueueState {
  return sqlite
    .prepare(
      "SELECT status, resolved_at, claimed_at, lease_expires_at FROM data_quality_remediation_queue WHERE id = ?",
    )
    .get(id) as unknown as QueueState;
}

test("compaction resolves only superseded automatic jobs and expired leases", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      is_active INTEGER NOT NULL,
      remediation_projection_required INTEGER NOT NULL,
      manufacturer_resolver_version INTEGER NOT NULL,
      model_resolver_version INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE product_identity_resolutions (
      listing_product_id INTEGER PRIMARY KEY,
      identity_resolver_version INTEGER NOT NULL
    );
    CREATE TABLE data_quality_remediation_queue (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      listing_product_id INTEGER,
      work_type TEXT NOT NULL,
      claimed_at TEXT,
      lease_expires_at TEXT,
      resolved_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    INSERT INTO products VALUES
      (1, 1, 0, 3, 2, '{"categoryClassification":{"version":${RESOLUTION_VERSIONS.category}}}'),
      (2, 1, 0, 3, 1, '{"categoryClassification":{"version":${RESOLUTION_VERSIONS.category}}}'),
      (3, 1, 0, 3, 2, '{"categoryClassification":{"version":${RESOLUTION_VERSIONS.category}}}'),
      (4, 1, 0, 3, 2, '{"categoryClassification":{"version":${RESOLUTION_VERSIONS.category}}}'),
      (5, 1, 0, 3, 2, '{"categoryClassification":{"version":${RESOLUTION_VERSIONS.category}}}'),
      (6, 1, 0, 3, 2, '{"categoryClassification":{"version":${RESOLUTION_VERSIONS.category}}}'),
      (7, 1, 0, 3, 2, '{"categoryClassification":{"version":${RESOLUTION_VERSIONS.category}}}'),
      (8, 0, 1, 0, 0, '{}'),
      (9, 1, 0, 3, 2, '{"categoryClassification":{"version":${RESOLUTION_VERSIONS.category}}}'),
      (10, 1, 1, 3, 2, '{"categoryClassification":{"version":${RESOLUTION_VERSIONS.category}}}');

    INSERT INTO product_identity_resolutions VALUES (4, 1), (7, 1);

    INSERT INTO data_quality_remediation_queue(
      id, status, source, reason, listing_product_id, work_type,
      claimed_at, lease_expires_at, resolved_at, updated_at
    ) VALUES
      (1, 'pending', 'scheduled_sweep', 'automatic_data_quality_remediation', 1, 'resolve_manufacturer', NULL, NULL, NULL, 'old'),
      (2, 'pending', 'scheduled_sweep', 'automatic_data_quality_remediation', 2, 'resolve_model', NULL, NULL, NULL, 'old'),
      (3, 'processing', 'scheduled_sweep', 'automatic_data_quality_remediation', 3, 'classify_category', 'old', '2026-08-16T00:00:00.000Z', NULL, 'old'),
      (4, 'processing', 'scheduled_sweep', 'automatic_data_quality_remediation', 4, 'resolve_identity', 'active', '2026-08-16T02:00:00.000Z', NULL, 'old'),
      (5, 'pending', 'manual', 'full_rebuild', 5, 'reprocess_listing', NULL, NULL, NULL, 'old'),
      (6, 'pending', 'scheduled_sweep', 'automatic_data_quality_remediation', 6, 'rebuild_search_entity', NULL, NULL, NULL, 'old'),
      (7, 'pending', 'manual', 'automatic_data_quality_remediation', 7, 'resolve_identity', NULL, NULL, NULL, 'old'),
      (8, 'pending', 'scheduled_sweep', 'automatic_data_quality_remediation', 8, 'resolve_model', NULL, NULL, NULL, 'old'),
      (9, 'pending', 'scheduled_sweep', 'automatic_data_quality_remediation', 9, 'resolve_identity', NULL, NULL, NULL, 'old'),
      (10, 'pending', 'scheduled_sweep', 'automatic_data_quality_remediation', 10, 'resolve_manufacturer', NULL, NULL, NULL, 'old');
  `);

  const now = "2026-08-16T01:00:00.000Z";
  const compacted = await compactSupersededAutomaticRemediationJobs(sqliteD1(sqlite), now);

  assert.equal(compacted, 4);
  for (const id of [1, 3, 6, 8]) {
    const row = state(sqlite, id);
    assert.equal(row.status, "resolved", `job ${id}`);
    assert.equal(row.resolved_at, now, `job ${id}`);
    assert.equal(row.claimed_at, null, `job ${id}`);
    assert.equal(row.lease_expires_at, null, `job ${id}`);
  }
  for (const id of [2, 4, 5, 7, 9, 10]) {
    assert.notEqual(state(sqlite, id).status, "resolved", `job ${id}`);
  }
  assert.equal(state(sqlite, 4).status, "processing");
  assert.equal(state(sqlite, 4).lease_expires_at, "2026-08-16T02:00:00.000Z");
});
