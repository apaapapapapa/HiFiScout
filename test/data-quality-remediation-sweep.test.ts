import assert from "node:assert/strict";
import { test } from "vitest";
import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import { captureDatabase } from "./helpers/d1.js";

const CLAIMED_JOB_ROW = {
  id: 1,
  work_key: "manual:listing:42",
  work_type: "resolve_identity",
  listing_product_id: 42,
  entity_id: "42",
  reason: "test",
  source: "manual",
  status: "processing",
  priority: 100,
  attempt_count: 1,
  max_attempts: 3,
  available_at: "2026-08-15T00:00:00.000Z",
  claimed_at: "2026-08-15T00:00:00.000Z",
  lease_expires_at: "2026-08-15T00:05:00.000Z",
  resolved_at: null,
  last_error: "",
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z",
};

const LISTING_ROW = {
  id: 42,
  shop_key: "audio-union",
  source_id: "listing-42",
  manufacturer: "TAD",
  raw_manufacturer: "TAD",
  normalized_raw_manufacturer: "tad",
  manufacturer_id: "tad",
  canonical_manufacturer_id: "tad",
  manufacturer_resolution_status: "resolved",
  manufacturer_resolution_method: "verified_alias",
  manufacturer_resolution_confidence: "high",
  manufacturer_resolver_version: 4,
  model: "D-1000MK2",
  raw_model: "D-1000 MK2",
  normalized_model: "D1000MK2",
  model_resolution_status: "resolved",
  model_resolution_method: "title_extraction",
  model_resolution_confidence: "high",
  model_resolver_version: 3,
  title: "TAD D-1000 MK2",
  category: "amplifier",
  raw_category: "amplifier",
  primary_category_id: "amplifier",
  category_ids: '["amplifier"]',
  classification_status: "classified",
  search_aliases: "",
  metadata_json: "{}",
  remediation_projection_required: 1,
  remediation_projection_token: "dq-replay:2026-08-15T00:00:00.000Z:42",
};

const SNAPSHOT_ROW = {
  total_items: 7,
  manufacturer_missing_count: 0,
  manufacturer_unresolved_count: 0,
  category_unclassified_count: 0,
  other_category_count: 0,
  identity_matched_count: 7,
  identity_unresolved_count: 0,
  identity_veto_count: 0,
  identity_candidate_count: 0,
  inventory_known_count: 7,
  inventory_unknown_count: 0,
  model_expected_count: 7,
  model_extracted_count: 7,
  model_missing_count: 0,
};

function sweepDatabase({ failSnapshot = false }: { failSnapshot?: boolean } = {}) {
  return captureDatabase((statement) => {
    const sql = statement.sql;
    if (/WHEN p\.manufacturer_resolver_version < \? THEN 'resolve_manufacturer'/.test(sql)) {
      return []; // nothing new to auto-seed this tick — one statement per staleness selector
    }
    // Claiming is a UNION ALL over the two claimable states; the `pending` branch is the one a
    // freshly seeded queue answers from.
    if (
      /FROM data_quality_remediation_queue INDEXED BY idx_dq_remediation_queue_pending/.test(sql)
    ) {
      return [{ id: 1 }];
    }
    if (/SELECT \*\s+FROM data_quality_remediation_queue\s+WHERE id IN/.test(sql)) {
      return [CLAIMED_JOB_ROW];
    }
    if (/SELECT attempt_count, max_attempts FROM data_quality_remediation_queue/.test(sql)) {
      return [{ attempt_count: 1, max_attempts: 3 }];
    }
    if (/FROM products\s+WHERE id = \?/.test(sql)) return [LISTING_ROW];
    if (/COUNT\(\*\) AS total_items/.test(sql)) {
      if (failSnapshot) throw new Error("snapshot unavailable");
      return [SNAPSHOT_ROW];
    }
    return [];
  });
}

test("a resolved job persists a fresh data-quality snapshot without inventing a crawl run", async () => {
  const db = sweepDatabase();

  const result = await runDataQualityRemediationSweep(db, {
    seedLimit: 10,
    claimLimit: 10,
    leaseSeconds: 300,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });

  assert.equal(result.resolved, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.affectedShops, ["audio-union"]);

  const insertIndex = db.calls.findIndex((call) => /INSERT INTO data_quality_runs/.test(call.sql));
  const resolveIndex = db.calls.findIndex((call) => /SET status = 'resolved'/.test(call.sql));
  assert.ok(insertIndex >= 0, "the sweep must persist the recomputed snapshot, not only log it");
  assert.ok(
    resolveIndex > insertIndex,
    "snapshot persistence must complete before the job is resolved",
  );

  const insert = db.calls[insertIndex];
  assert.ok(insert);
  assert.equal(insert.binds[0], "audio-union");
  assert.equal(insert.binds[1], null, "crawl_run_id stays null: no synthetic crawl is invented");
  assert.equal(insert.binds[3], 7, "total_items comes from the freshly read snapshot");
  assert.equal(
    insert.binds[23],
    null,
    "no crawl happened this tick, so there is no previous count to compare",
  );
  assert.equal(
    insert.binds[24],
    7,
    "current_item_count defaults to the snapshot total rather than zero",
  );
});

test("snapshot finalization failure retries the processed job instead of resolving it", async () => {
  const db = sweepDatabase({ failSnapshot: true });

  const result = await runDataQualityRemediationSweep(db, {
    seedLimit: 10,
    claimLimit: 10,
    leaseSeconds: 300,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });

  assert.equal(result.resolved, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.retried, 1);
  assert.deepEqual(result.affectedShops, ["audio-union"]);
  assert.ok(!db.calls.some((call) => /SET status = 'resolved'/.test(call.sql)));
  const retry = db.calls.find(
    (call) => /SET status = \?, available_at = \?/.test(call.sql) && call.binds[0] === "pending",
  );
  assert.ok(
    retry,
    "snapshot failure must return the already-processed job to the durable retry path",
  );
  assert.match(String(retry.binds[4]), /snapshot unavailable/);
});

test("an empty claim leaves the data-quality history untouched", async () => {
  // Every read answers empty, which is what an idle tick looks like: nothing stale to seed and
  // nothing claimable in either state.
  const db = captureDatabase(() => []);

  const result = await runDataQualityRemediationSweep(db, {
    now: new Date("2026-08-15T00:00:00.000Z"),
  });

  assert.equal(result.resolved, 0);
  assert.deepEqual(result.affectedShops, []);
  assert.ok(!db.calls.some((call) => /INSERT INTO data_quality_runs/.test(call.sql)));
});
