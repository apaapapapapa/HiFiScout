import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { evaluateQuality } from "../src/data-quality/quality-evaluator.js";

function crawlOutcome(overrides = {}) {
  return {
    shopKey: "integration-shop",
    totalItems: 100,
    manufacturerMissingCount: 0,
    manufacturerUnresolvedCount: 0,
    categoryUnclassifiedCount: 1,
    otherCategoryCount: 0,
    identityMatchedCount: 90,
    identityUnresolvedCount: 10,
    identityVetoCount: 0,
    identityCandidateCount: 0,
    inventoryKnownCount: 100,
    inventoryUnknownCount: 0,
    modelExpectedCount: 80,
    modelExtractedCount: 78,
    modelMissingCount: 2,
    parseAttemptCount: 10,
    parseSuccessCount: 10,
    parseFailureCount: 0,
    evidenceExpectedEventCount: 0,
    evidenceArchivedEventCount: 0,
    evidenceArchiveFailureCount: 0,
    previousItemCount: 100,
    currentItemCount: 100,
    ...overrides,
  };
}

test("normal crawl outcome produces healthy snapshot and run quality", () => {
  const quality = evaluateQuality(crawlOutcome());
  assert.equal(quality.snapshot.status, "healthy");
  assert.equal(quality.run.status, "healthy");
  assert.equal(quality.status, "healthy");
});

test("category degradation is a snapshot warning without poisoning run quality", () => {
  const quality = evaluateQuality(crawlOutcome({ categoryUnclassifiedCount: 4 }));
  assert.equal(quality.snapshot.metrics.categoryUnclassified.status, "warning");
  assert.equal(quality.snapshot.status, "warning");
  assert.equal(quality.run.status, "healthy");
  assert.equal(quality.status, "warning");
});

test("large crawl item drop is critical run quality", () => {
  const quality = evaluateQuality(crawlOutcome({ previousItemCount: 1000, currentItemCount: 300 }));
  assert.equal("latestRun" in quality, false);
  assert.equal(quality.run.metrics.itemCount.changeRate, -0.7);
  assert.equal(quality.run.metrics.itemCount.status, "critical");
  assert.equal(quality.run.status, "critical");
  assert.equal(quality.status, "critical");
});
