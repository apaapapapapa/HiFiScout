import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { remediationOperationalMetrics } from "../src/db/data-quality-remediation-metrics.js";

test("remediation operational metrics expose backlog and terminal failure rate", () => {
  const metrics = remediationOperationalMetrics({
    pending: 3,
    processing: 2,
    resolved: 8,
    failed: 2,
    backlog: 5,
    oldestPendingAt: "2026-08-15T00:00:00.000Z",
  });

  assert.equal(metrics.backlog, 5);
  assert.equal(metrics.completed, 10);
  assert.equal(metrics.failureRate, 0.2);
});

test("failure rate is null before any work reaches a terminal state", () => {
  const metrics = remediationOperationalMetrics({
    pending: 1,
    processing: 0,
    resolved: 0,
    failed: 0,
    backlog: 1,
    oldestPendingAt: "2026-08-15T00:00:00.000Z",
  });

  assert.equal(metrics.failureRate, null);
});
