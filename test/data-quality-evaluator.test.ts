import assert from "node:assert/strict";
import test from "node:test";
import { evaluateQuality, rate } from "../src/data-quality/quality-evaluator.js";

function healthyInput(overrides = {}) {
  return {
    shopKey: "test-shop",
    totalItems: 100,
    manufacturerMissingCount: 0,
    manufacturerUnresolvedCount: 0,
    categoryUnclassifiedCount: 1,
    identityMatchedCount: 90,
    identityUnresolvedCount: 10,
    inventoryKnownCount: 100,
    inventoryUnknownCount: 0,
    modelExpectedCount: 80,
    modelExtractedCount: 78,
    modelMissingCount: 2,
    parseAttemptCount: 10,
    parseSuccessCount: 10,
    parseFailureCount: 0,
    evidenceExpectedEventCount: 1,
    evidenceArchivedEventCount: 1,
    evidenceArchiveFailureCount: 0,
    previousItemCount: 100,
    currentItemCount: 100,
    ...overrides,
  };
}

test("rate returns null for a zero denominator", () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(2, 100), 0.02);
});

test("normal quality is healthy", () => {
  const result = evaluateQuality(healthyInput());
  assert.equal(result.snapshot.status, "healthy");
  assert.equal(result.run.status, "healthy");
  assert.equal(result.status, "healthy");
  assert.equal(result.metrics.categoryUnclassified.rate, 0.01);
});

test("high-rate warning and critical thresholds include exact boundaries", () => {
  const warning = evaluateQuality(healthyInput({ manufacturerMissingCount: 2 }));
  assert.equal(warning.metrics.manufacturerUnknown.status, "warning");

  const critical = evaluateQuality(healthyInput({ manufacturerMissingCount: 5 }));
  assert.equal(critical.metrics.manufacturerUnknown.status, "critical");
});

test("unknown is retained when a denominator does not exist", () => {
  const result = evaluateQuality(
    healthyInput({ identityMatchedCount: 0, identityUnresolvedCount: 0, modelExpectedCount: 0 }),
  );
  assert.equal(result.metrics.identityUnresolved.status, "unknown");
  assert.equal(result.metrics.modelMissing.status, "unknown");
});

test("model rate uses model expected rather than total items", () => {
  const result = evaluateQuality(
    healthyInput({
      totalItems: 100,
      modelExpectedCount: 50,
      modelExtractedCount: 45,
      modelMissingCount: 5,
    }),
  );
  assert.equal(result.metrics.modelMissing.denominator, 50);
  assert.equal(result.metrics.modelMissing.rate, 0.1);
  assert.equal(result.metrics.modelMissing.status, "warning");
});

test("item count increase is healthy and first crawl is unknown", () => {
  const increased = evaluateQuality(
    healthyInput({ previousItemCount: 100, currentItemCount: 120 }),
  );
  assert.equal(increased.metrics.itemCount.changeRate, 0.2);
  assert.equal(increased.metrics.itemCount.status, "healthy");

  const first = evaluateQuality(healthyInput({ previousItemCount: null, currentItemCount: 120 }));
  assert.equal(first.metrics.itemCount.changeRate, null);
  assert.equal(first.metrics.itemCount.status, "unknown");
});

test("item count drop uses inclusive warning and critical boundaries", () => {
  const warning = evaluateQuality(healthyInput({ previousItemCount: 100, currentItemCount: 80 }));
  assert.equal(warning.metrics.itemCount.status, "warning");

  const critical = evaluateQuality(healthyInput({ previousItemCount: 100, currentItemCount: 50 }));
  assert.equal(critical.metrics.itemCount.status, "critical");
});

test("evidence coverage evaluates only expected anomaly events", () => {
  const noneExpected = evaluateQuality(
    healthyInput({ evidenceExpectedEventCount: 0, evidenceArchivedEventCount: 0 }),
  );
  assert.equal(noneExpected.metrics.evidenceCoverage.status, "unknown");

  const critical = evaluateQuality(
    healthyInput({ evidenceExpectedEventCount: 10, evidenceArchivedEventCount: 7 }),
  );
  assert.equal(critical.metrics.evidenceCoverage.rate, 0.7);
  assert.equal(critical.metrics.evidenceCoverage.status, "critical");
});

test("evidence coverage warning and critical boundaries are strict", () => {
  const healthy = evaluateQuality(
    healthyInput({ evidenceExpectedEventCount: 20, evidenceArchivedEventCount: 19 }),
  );
  assert.equal(healthy.metrics.evidenceCoverage.rate, 0.95);
  assert.equal(healthy.metrics.evidenceCoverage.status, "healthy");

  const warning = evaluateQuality(
    healthyInput({ evidenceExpectedEventCount: 10, evidenceArchivedEventCount: 8 }),
  );
  assert.equal(warning.metrics.evidenceCoverage.rate, 0.8);
  assert.equal(warning.metrics.evidenceCoverage.status, "warning");

  const critical = evaluateQuality(
    healthyInput({ evidenceExpectedEventCount: 100, evidenceArchivedEventCount: 79 }),
  );
  assert.equal(critical.metrics.evidenceCoverage.status, "critical");
});

test("shop overrides replace only declared thresholds", () => {
  const result = evaluateQuality(healthyInput({ manufacturerMissingCount: 3 }), {
    thresholdOverrides: {
      manufacturerUnknownRate: { warning: 0.04, critical: 0.08 },
    },
  });
  assert.equal(result.metrics.manufacturerUnknown.status, "healthy");
  assert.equal(result.metrics.categoryUnclassified.status, "healthy");
});
