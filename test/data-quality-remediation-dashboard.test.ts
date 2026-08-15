import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRemediationSlo } from "../src/data-quality/remediation-slo.js";
import {
  buildRemediationDashboardMetric,
  REMEDIATION_DASHBOARD_LIMITS,
} from "../src/data-quality/remediation-dashboard.js";
import { listIdentityResolutionMethodDistribution } from "../src/db/data-quality-remediation-dashboard-repository.js";
import {
  DATA_QUALITY_REBUILD_ORDER,
  parseDataQualityRebuildRequest,
} from "../src/http/remediation-admin.js";
import { captureDatabase } from "./helpers/d1.js";

function quality(id: number, evaluatedAt: string, manufacturerUnknownRate: number) {
  return {
    id,
    evaluatedAt,
    remediationSlo: evaluateRemediationSlo({
      totalItems: 100,
      identityResolutionRowCount: 100,
      manufacturerUnknownRate,
      categoryUnclassifiedRate: 0.05,
      identityUnresolvedRate: 0.4,
      inventoryUnknownRate: 0.01,
      modelMissingRate: 0.01,
      evidenceCoverageRate: 0.99,
    }),
  };
}

function closeTo(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(Number(actual) - expected) < 1e-10);
}

test("dashboard compares current, previous and rollout baseline with chronological trend", () => {
  const oldest = quality(1, "2026-08-15T00:00:00.000Z", 0.4);
  const previous = quality(2, "2026-08-15T01:00:00.000Z", 0.3);
  const current = quality(3, "2026-08-15T02:00:00.000Z", 0.2);
  const metric = buildRemediationDashboardMetric(
    "manufacturerUnknown",
    current,
    [current, previous, oldest],
    0.8315,
  );
  assert.equal(metric.currentValue, 0.2);
  assert.equal(metric.threshold, 0.1);
  assert.equal(metric.previousValue, 0.3);
  closeTo(metric.absoluteDelta, -0.1);
  closeTo(metric.percentageDelta, -1 / 3);
  assert.equal(metric.trendDirection, "improving");
  assert.deepEqual(
    metric.trend.map((point) => point.value),
    [0.4, 0.3, 0.2],
  );
  closeTo(metric.rolloutAbsoluteDelta, 0.2 - 0.8315);
});

test("identity method distribution is active-only and bounded", async () => {
  const db = captureDatabase([
    {
      status: "matched",
      match_method: "manufacturer_model_exact",
      listing_count: 20,
      shop_count: 3,
    },
  ]);
  const distribution = await listIdentityResolutionMethodDistribution(db);
  assert.deepEqual(distribution, [
    {
      status: "matched",
      method: "manufacturer_model_exact",
      listingCount: 20,
      shopCount: 3,
    },
  ]);
  assert.match(db.calls[0]?.sql || "", /p\.is_active = 1/);
  assert.match(db.calls[0]?.sql || "", /LIMIT \?/);
  assert.deepEqual(db.calls[0]?.binds, [REMEDIATION_DASHBOARD_LIMITS.identityMethods]);
});

test("full rebuild admin request is restartable and fails closed on invalid cursors", () => {
  assert.deepEqual(
    parseDataQualityRebuildRequest({
      afterId: 125,
      limit: 50,
      rebuildKey: "rollout-v1",
    }),
    { afterId: 125, limit: 50, rebuildKey: "rollout-v1" },
  );
  assert.deepEqual(parseDataQualityRebuildRequest(undefined), {});
  assert.equal(parseDataQualityRebuildRequest({ afterId: -1 }), null);
  assert.equal(parseDataQualityRebuildRequest({ limit: 0 }), null);
  assert.equal(parseDataQualityRebuildRequest({ rebuildKey: "contains spaces" }), null);
  assert.deepEqual(DATA_QUALITY_REBUILD_ORDER, [
    "raw_source_fields",
    "canonical_manufacturer",
    "model",
    "category_features",
    "knowledge_catalog_candidates",
    "product_identity",
    "product_search_entities",
    "data_quality_snapshot",
  ]);
});
