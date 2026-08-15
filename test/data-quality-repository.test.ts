import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_OPTIONAL_CATEGORIES,
  dataQualityRow,
  latestDataQualityByShop,
  listDataQualityHistory,
  readDataQualitySnapshot,
  saveDataQualityRun,
} from "../src/db/data-quality-repository.js";
import { asQueryableDatabase } from "./helpers/d1.js";

interface CapturedCall {
  kind: "first" | "all" | "run";
  sql: string;
  binds: unknown[];
}

function captureDb({
  firstRows = [],
  allRows = [],
}: { firstRows?: unknown[]; allRows?: unknown[][] } = {}) {
  const calls: CapturedCall[] = [];
  let firstIndex = 0;
  let allIndex = 0;
  return asQueryableDatabase({
    calls,
    prepare(sql: string) {
      const statement = {
        sql,
        binds: [] as unknown[],
        bind(...binds: unknown[]) {
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
  });
}

const snapshotRow = {
  total_items: 100,
  manufacturer_missing_count: 1,
  manufacturer_unresolved_count: 1,
  category_unclassified_count: 2,
  other_category_count: 3,
  identity_matched_count: 80,
  identity_unresolved_count: 15,
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
  assert.match(db.calls[0].sql, /LEFT JOIN product_identity_resolutions/);
  assert.match(db.calls[0].sql, /p\.is_active = 1/);
  assert.match(db.calls[0].sql, /manufacturer_resolution_status/);
  assert.doesNotMatch(db.calls[0].sql, /manufacturerNormalization\.matchedAlias/);
  assert.doesNotMatch(db.calls[0].sql, /SELECT p\.\*/);
});

test("model expectation excludes canonical accessory categories and other", async () => {
  assert.deepEqual(MODEL_OPTIONAL_CATEGORIES, [
    "cable",
    "rack",
    "power_accessory",
    "vacuum_tube",
    "other_accessory",
    "other",
  ]);

  const db = captureDb({ firstRows: [snapshotRow] });
  await readDataQualitySnapshot(db, "audio-union");
  const sql = db.calls[0].sql;

  for (const category of MODEL_OPTIONAL_CATEGORIES) {
    assert.match(sql, new RegExp(`'${category}'`));
  }
  assert.doesNotMatch(sql, /'accessory'/);
});

test("quality result is linked to crawl run and persists snapshot and run statuses", async () => {
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
  assert.ok(insert);
  assert.equal(result.crawlRunId, 42);
  assert.equal(result.snapshot.metrics.identityUnresolved.count, 20);
  assert.equal(result.snapshot.metrics.identityUnresolved.denominator, 100);
  assert.equal(result.snapshot.status, "warning");
  assert.equal(result.run.status, "healthy");
  assert.equal(insert.binds[0], "audio-union");
  assert.equal(insert.binds[1], 42);
  assert.equal(insert.binds.length, 38);
  assert.match(insert.sql, /ON CONFLICT\(crawl_run_id\)/);
  assert.match(insert.sql, /snapshot_status/);
  assert.match(insert.sql, /run_status/);
  assert.match(insert.sql, /quality_status/);
});

test("history query is bounded to 200 rows", async () => {
  const db = captureDb({ allRows: [[]] });
  await listDataQualityHistory(db, "audio-union", 5000);
  assert.deepEqual(db.calls[0].binds, ["audio-union", 200]);
  assert.match(db.calls[0].sql, /LIMIT \?/);
});

test("stored row exposes identity coverage gaps against all active listings", () => {
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
    identity_unresolved_count: 15,
    identity_veto_count: 2,
    identity_candidate_count: 4,
    inventory_known_count: 99,
    inventory_unknown_count: 1,
    model_expected_count: 80,
    model_extracted_count: 76,
    model_missing_count: 4,
    parse_attempt_count: 10,
    parse_success_count: 10,
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
    snapshot_status: "warning",
    run_status: "healthy",
    quality_status: "warning",
  });

  assert.deepEqual(row.snapshot.metrics.manufacturerUnknown, {
    count: 2,
    denominator: 100,
    rate: 0.02,
    status: "warning",
  });
  assert.deepEqual(row.snapshot.metrics.identityUnresolved, {
    count: 20,
    denominator: 100,
    rate: 0.2,
    status: "warning",
  });
  assert.equal(row.details.identityResolutionMissingCount, 5);
  assert.equal(row.latestRun.metrics.itemCount.previous, 105);
  assert.equal(row.snapshot.status, "warning");
  assert.equal(row.latestRun.status, "healthy");
  assert.equal(row.crawlRunId, 42);
});

test("a remediation-triggered run without an explicit item count defaults to the snapshot total", async () => {
  const db = captureDb({ firstRows: [snapshotRow] });
  const result = await saveDataQualityRun(db, {
    shopKey: "audio-union",
    crawlRunId: null,
    evaluatedAt: "2026-08-15T00:00:00.000Z",
  });

  assert.equal(result.run.metrics.itemCount.current, 100);
  assert.equal(result.run.metrics.itemCount.previous, null);
  assert.equal(result.run.metrics.itemCount.status, "unknown");
  const insert = db.calls.find((call) => call.kind === "run");
  assert.ok(insert);
  assert.equal(insert.binds[0], "audio-union");
  assert.equal(insert.binds[1], null);
});

test("a crawl run's explicit item count still overrides the snapshot default", async () => {
  const db = captureDb({ firstRows: [snapshotRow] });
  const result = await saveDataQualityRun(db, {
    shopKey: "audio-union",
    crawlRunId: 7,
    evaluatedAt: "2026-08-15T00:00:00.000Z",
    run: { previousItemCount: 90, currentItemCount: 95 },
  });

  assert.equal(result.run.metrics.itemCount.current, 95);
  assert.equal(result.run.metrics.itemCount.previous, 90);
});

function runRow(overrides: Record<string, unknown> = {}) {
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
    parse_attempt_count: 0,
    parse_success_count: 0,
    parse_failure_count: 0,
    evidence_expected_event_count: 0,
    evidence_archived_event_count: 0,
    evidence_archive_failure_count: 0,
    previous_item_count: null,
    current_item_count: 100,
    item_count_absolute_difference: null,
    item_count_change_rate: null,
    manufacturer_status: "healthy",
    category_status: "healthy",
    identity_status: "healthy",
    inventory_status: "healthy",
    model_status: "healthy",
    parser_status: "unknown",
    item_count_status: "unknown",
    evidence_status: "unknown",
    snapshot_status: "healthy",
    run_status: "unknown",
    quality_status: "healthy",
    rn_latest: 1,
    rn_latest_crawl: 2,
    ...overrides,
  };
}

test("a remediation-only row cannot bury a real crawl's parser-failure critical", async () => {
  const criticalCrawl = runRow({
    id: 1,
    crawl_run_id: 10,
    evaluated_at: "2026-08-15T00:00:00.000Z",
    parse_attempt_count: 10,
    parse_failure_count: 9,
    parser_status: "critical",
    item_count_status: "healthy",
    evidence_status: "unknown",
    run_status: "critical",
    quality_status: "critical",
    rn_latest: 2,
    rn_latest_crawl: 1,
  });
  const remediationOnlyRun = runRow({
    id: 2,
    crawl_run_id: null,
    evaluated_at: "2026-08-15T01:00:00.000Z",
    manufacturer_missing_count: 0,
    rn_latest: 1,
    rn_latest_crawl: 3,
  });
  const db = captureDb({ allRows: [[remediationOnlyRun, criticalCrawl]] });

  const [shop] = await latestDataQualityByShop(db);

  // The remediation row is newer, but it never measured parser health — the last real crawl's
  // critical parser failure must still be what /status reports, not a fabricated "unknown".
  assert.equal(shop.id, 2);
  assert.equal(shop.evaluatedAt, "2026-08-15T01:00:00.000Z");
  assert.equal(shop.status, "critical");
  assert.equal(shop.latestRun.status, "critical");
  assert.equal(shop.metrics.parserFailure.status, "critical");
  assert.equal(shop.metrics.parserFailure.rate, 0.9);
  assert.match(db.calls[0].sql, /rn_latest_crawl/);
});

test("the common case (no intervening remediation row) is unaffected", async () => {
  const onlyCrawl = runRow({
    id: 1,
    crawl_run_id: 10,
    parser_status: "healthy",
    run_status: "healthy",
    quality_status: "healthy",
    rn_latest: 1,
    rn_latest_crawl: 1,
  });
  const db = captureDb({ allRows: [[onlyCrawl]] });

  const [shop] = await latestDataQualityByShop(db);

  assert.equal(shop.id, 1);
  assert.equal(shop.status, "healthy");
});
