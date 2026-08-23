import assert from "node:assert/strict";
import { test } from "vitest";
import {
  evaluateRemediationSlo,
  REMEDIATION_NEXT_TARGETS,
} from "../src/data-quality/remediation-slo.js";

function healthyInput(overrides = {}) {
  return {
    totalItems: 100,
    identityResolutionRowCount: 100,
    manufacturerUnknownRate: 0.09,
    categoryUnclassifiedRate: 0.09,
    identityUnresolvedRate: 0.49,
    inventoryUnknownRate: 0.04,
    modelMissingRate: 0.04,
    evidenceCoverageRate: 0.96,
    ...overrides,
  };
}

test("initial remediation milestone is healthy only below/above the declared strict targets", () => {
  const result = evaluateRemediationSlo(healthyInput());
  assert.equal(result.status, "healthy");
  assert.equal(result.structuralStatus, "healthy");
  assert.equal(result.sourceStatus, "healthy");
  assert.equal(result.metrics.identityCoverage.rate, 1);
});

test("source-dependent milestone misses are warnings rather than deployment-blocking criticals", () => {
  const result = evaluateRemediationSlo(
    healthyInput({
      manufacturerUnknownRate: 0.1,
      categoryUnclassifiedRate: 0.1,
      identityUnresolvedRate: 0.5,
      inventoryUnknownRate: 0.05,
      modelMissingRate: 0.05,
      evidenceCoverageRate: 0.95,
    }),
  );

  assert.equal(result.sourceStatus, "warning");
  assert.equal(result.structuralStatus, "healthy");
  assert.equal(result.status, "warning");
  assert.equal(result.metrics.manufacturerUnknown.met, false);
  assert.equal(result.metrics.evidenceCoverage.met, false);
});

test("missing required Product Identity rows are a structural critical", () => {
  const result = evaluateRemediationSlo(healthyInput({ identityResolutionRowCount: 99 }));
  assert.equal(result.metrics.identityCoverage.rate, 0.99);
  assert.equal(result.metrics.identityCoverage.status, "critical");
  assert.equal(result.structuralStatus, "critical");
  assert.equal(result.status, "critical");
});

test("empty source keeps denominator-dependent identity coverage unknown", () => {
  const result = evaluateRemediationSlo(
    healthyInput({ totalItems: 0, identityResolutionRowCount: 0 }),
  );
  assert.equal(result.metrics.identityCoverage.rate, null);
  assert.equal(result.metrics.identityCoverage.status, "unknown");
});

test("later tightening goals are exposed separately from the initial milestone", () => {
  assert.deepEqual(REMEDIATION_NEXT_TARGETS, {
    manufacturerUnknownRate: 0.02,
    categoryUnclassifiedRate: 0.03,
    identityUnresolvedRate: 0.2,
  });
});
