import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  collectReplayCases,
  compareReplays,
  REPLAY_SUITES,
  replayReport,
  type ReplayResult,
} from "../scripts/harness/replay.js";

function fixture(): ReplayResult {
  return {
    schemaVersion: 1,
    kind: "product-replay",
    sourceSha: "a".repeat(40),
    corpusHash: "b".repeat(64),
    environment: "local-test",
    checkoutStable: true,
    missingSuites: [],
    cases: Object.entries(REPLAY_SUITES).map(([file, stage]) => ({
      id: `${file}::incident`,
      stage,
      status: "pass",
      failures: [],
    })),
  };
}

test("replay retains failed and skipped assertions and missing stages without inventing success", () => {
  const selected = Object.keys(REPLAY_SUITES)[0];
  const report = {
    testResults: [
      {
        name: `/runner/work/repo/${selected}`,
        assertionResults: [
          {
            fullName: "broken extraction",
            status: "failed",
            failureMessages: ["expected model D1000MK2"],
          },
          { fullName: "pending extraction", status: "pending", failureMessages: [] },
        ],
      },
    ],
  };
  const cases = collectReplayCases([report]);
  assert.equal(cases.cases.find((item) => item.id.endsWith("::broken extraction"))?.status, "fail");
  assert.equal(
    cases.cases.find((item) => item.id.endsWith("::pending extraction"))?.status,
    "unknown",
  );
  assert.equal(cases.missingSuites.length, Object.keys(REPLAY_SUITES).length - 1);
  const assessed = replayReport(
    { ...fixture(), ...cases },
    "2026-09-13T00:00:00Z",
    "2026-09-13T00:01:00Z",
  );
  assert.equal(assessed.status, "fail");
  assert.equal(assessed.checks.find((check) => check.id === "replay/search")?.status, "unknown");
  assert.throws(() => collectReplayCases([report, report]), /duplicate_replay_suite/u);
});

test("before/after replay reports exact regressed cases and refuses changed, missing or stale evidence", () => {
  const before = fixture(),
    after = fixture();
  after.sourceSha = "c".repeat(40);
  after.cases[0].status = "fail";
  after.cases[0].failures = ["model revision merged"];
  assert.equal(compareReplays(before, after).status, "fail");
  assert.equal(compareReplays(before, after).regressions[0].id, after.cases[0].id);
  assert.equal(compareReplays(after, before).improvements.length, 1);
  for (const incomplete of [
    { ...after, corpusHash: "d".repeat(64) },
    { ...after, cases: after.cases.slice(1) },
    { ...after, checkoutStable: false },
    { ...after, cases: after.cases.map((item) => ({ ...item, status: "unknown" })) },
  ])
    assert.equal(compareReplays(before, incomplete).status, "unknown");
});
