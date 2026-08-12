import assert from "node:assert/strict";
import test from "node:test";
import {
  dataQualityRow,
  listDataQualityHistory,
  readDataQualitySnapshot,
  saveDataQualityRun,
} from "../src/db/data-quality-repository.js";

function captureDb({ firstRows = [], allRows = [] } = {}) {
  const calls = [];
  let firstIndex = 0;
  let allIndex = 0;
  return {
    calls,
    prepare(sql) {
      const statement = {
        sql,
        binds: [],
        bind(...binds) {
          statement.binds = binds;
          return statement;
        },
        async first() {
          calls.push({ kind: "first", sql, binds: statement.binds });
          return firstRows[firstIndex++] || null;
        },
        async all() {
          calls.push({ kind: "all", sql, binds: statement.binds });
          return { results: allRows[allIndex++] || [] };
        },
        async run() {
          calls.push({ kind: "run", sql, binds: statement.binds });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  };
}

const snapshotRow = {
  total_items: 100,
  manufacturer_missing_count: 1,
  manufacturer_unresolved_count: 1,
  category_unclassified_count: 2,
  other_category_count: 3,
  identity_matched_count: 80,
  identity_unresolved_count: 20,
  identity_veto_count: 2,
  identity_candidate_count: 4,
  inventory_known_count: 99,
  inventory_unknown_count: 1,
  model_expected_count: 80,
  model_extracted_count: 76,
  model_missing_count: 4,
};

test("snapshot uses one D1 aggregate over active shop listings", async () => {
  const db = captureDb({ firstRows: [snapshotRow] });
  const result = await readDataQualitySnapshot(db, "audio-union");

  assert.equal(result.totalItems, 100);
  assert.equal(result.manufacturerUnresolvedCount, 1);
  assert.deepEqual(db.calls[0].binds, ["audio-union"]);
  assert.match(db.calls[0].sql, /COUNT\(\*\)/);
  assert.match(db.calls[0].sql, /SUM\(CASE/);
  assert.match(db.calls[0].sql, /p\.is_active = 1/);
  assert.match(db.calls[0].sql, /manufacturerNormalization\.matchedAlias/);
  assert.doesNotMatch(db.calls[0].sql, /SELECT p\.\*/);
});

test("quality result is linked to crawl run and persisted with transparent statuses", async () => {
  const db = captureDb({ firstRows: [snapshotRow] });
  const result = await saveDataQualityRun(db, {
    shopKey: "audio-union",
    crawlRunId: 42,
    evaluatedAt: "2026-08-12T13:00:00.000Z",
    run: {
      parseAttemptCount: 10,
      parseSuccessCount: 10,
      parseFailureCount: 0,
      evidenceExpectedEventCount: 1,
      evidenceArchivedEventCount: 1,
      previousItemCount: 100,
      currentItemCount: 100,
    },
  });

  const insert = db.calls.find((call) => call.kind === "run");
  assert.equal(result.crawlRunId, 42);
  assert.equal(insert.binds[0], "audio-union");
  assert.equal(insert.binds[1], 42);
  assert.equal(insert.binds.length, 36);
  assert.match(insert.sql, /ON CONFLICT\(crawl_run_id\)/);
  assert.match(insert.sql, /quality_status/);
});

test("history query is bounded to 200 rows", async () => {
  const db = captureDb({ allRows: [[]] });
  await listDataQualityHistory(db, "audio-union", 5000);
  assert.deepEqual(db.calls[0].binds, ["audio-union", 200]);
  assert.match(db.calls[0].sql, /LIMIT \?/);
});

test("stored row exposes count denominator rate and previous comparison", () => {
  const row = dataQualityRow({
    id: 1,
    shop_key: "audio-union",
    crawl_run_id: 42,
    evaluated_at: "2026-08-12T13:00:00.000Z",
    total_items: 100,
    manufacturer_missing_count: 1,
    manufacturer_unresolved_count: 1,
    category_unclassified_count: 2,
    other_category_count: 3,
    identity_matched_count: 80,
    identity_unresolved_count: 20,
    identity_veto_count: 2,
    identity_candidate_count: 4,
    inventory_known_count: 99,
    inventory_unknown_count: 1,
    model_expected_count: 80,
    model_extracted_count: 76,
    model_missing_count: 4,
    parse_attempt_count: 10,
    parse_failure_count: 0,
    evidence_expected_event_count: 1,
    evidence_archived_event_count: 1,
    evidence_archive_failure_count: 0,
    previous_item_count: 105,
    current_item_count: 100,
    item_count_absolute_difference: -5,
    item_count_change_rate: -5 / 105,
    manufacturer_status: "warning",
    category_status: "healthy",
    identity_status: "warning",
    inventory_status: "healthy",
    model_status: "healthy",
    parser_status: "healthy",
    item_count_status: "healthy",
    evidence_status: "healthy",
    quality_status: "warning",
  });

  assert.deepEqual(row.metrics.manufacturerUnknown, {
    count: 2,
    denominator: 100,
    rate: 0.02,
    status: "warning",
  });
  assert.equal(row.metrics.itemCount.previous, 105);
  assert.equal(row.crawlRunId, 42);
});
