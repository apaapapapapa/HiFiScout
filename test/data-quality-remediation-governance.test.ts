import assert from "node:assert/strict";
import test from "node:test";
import { dataQualityStatusWithRemediationSlo } from "../src/db/data-quality-remediation-governance-repository.js";
import { captureDatabase } from "./helpers/d1.js";

function dataQualityRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    shop_key: "audio-union",
    crawl_run_id: null,
    evaluated_at: "2026-08-15T00:00:00.000Z",
    total_items: 100,
    manufacturer_missing_count: 0,
    manufacturer_unresolved_count: 0,
    category_unclassified_count: 0,
    other_category_count: 0,
    identity_matched_count: 100,
    identity_unresolved_count: 0,
    identity_veto_count: 0,
    identity_candidate_count: 0,
    inventory_known_count: 100,
    inventory_unknown_count: 0,
    model_expected_count: 100,
    model_extracted_count: 100,
    model_missing_count: 0,
    parse_attempt_count: 10,
    parse_success_count: 10,
    parse_failure_count: 0,
    evidence_expected_event_count: 0,
    evidence_archived_event_count: 0,
    evidence_archive_failure_count: 0,
    previous_item_count: 100,
    current_item_count: 100,
    item_count_absolute_difference: 0,
    item_count_change_rate: 0,
    manufacturer_status: "healthy",
    category_status: "healthy",
    identity_status: "healthy",
    inventory_status: "healthy",
    model_status: "healthy",
    parser_status: "healthy",
    item_count_status: "healthy",
    evidence_status: "healthy",
    snapshot_status: "healthy",
    run_status: "healthy",
    quality_status: "healthy",
    ...overrides,
  };
}

test("status surfaces remediation queue backlog/failure health alongside per-shop quality and trend", async () => {
  const db = captureDatabase((statement) => {
    if (/ROW_NUMBER\(\) OVER/.test(statement.sql)) return [dataQualityRunRow()];
    if (/FROM data_quality_remediation_queue/.test(statement.sql)) {
      return [
        {
          pending: 2,
          processing: 1,
          resolved: 5,
          failed: 1,
          oldest_pending_at: "2026-08-15T00:00:00.000Z",
        },
      ];
    }
    return [];
  });

  const status = await dataQualityStatusWithRemediationSlo(db);

  assert.equal(status.remediationQueue.backlog, 3);
  assert.equal(status.remediationQueue.completed, 6);
  assert.equal(status.remediationQueue.failureRate, 1 / 6);
  assert.equal(status.shops.length, 1);
  assert.equal(status.shops[0].remediationSlo.milestone, "initial");
  // The governance wrapper must not drop the trend the Phase 2 layer already computed.
  assert.ok(status.shops[0].trend);
  assert.equal(status.shops[0].trend.manufacturerUnknown.previousRate, null);
});

test("an idle queue reports a null failure rate rather than a divide-by-zero", async () => {
  const db = captureDatabase((statement) => {
    if (/ROW_NUMBER\(\) OVER/.test(statement.sql)) return [];
    if (/FROM data_quality_remediation_queue/.test(statement.sql)) {
      return [{ pending: 0, processing: 0, resolved: 0, failed: 0, oldest_pending_at: null }];
    }
    return [];
  });

  const status = await dataQualityStatusWithRemediationSlo(db);

  assert.equal(status.remediationQueue.backlog, 0);
  assert.equal(status.remediationQueue.failureRate, null);
  assert.deepEqual(status.shops, []);
  assert.equal(status.status, "unknown");
});
