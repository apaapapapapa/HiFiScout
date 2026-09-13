import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  assessHarnessReport,
  parseHarnessReport,
  reportExitCode,
} from "../scripts/harness/report.js";
import type { HarnessReport } from "../scripts/harness/report.js";

const sha = "a".repeat(40);
function fixture(): HarnessReport {
  return {
    schemaVersion: 1,
    runId: "local-regression",
    sourceSha: sha,
    baselineSha: null,
    deploymentSha: null,
    startedAt: "2026-09-13T00:00:00Z",
    finishedAt: "2026-09-13T00:01:00Z",
    checks: [
      {
        id: "acceptance",
        required: true,
        scope: "source",
        status: "pass",
        reason: "Fixture reproduced the expected outcome",
        evidence: [{ uri: ".generated/harness/result.json", sourceSha: sha }],
      },
    ],
  };
}

test("completion requires evidence for the requested source and actual deployment", () => {
  const report = fixture();
  assert.equal(assessHarnessReport(report).status, "pass");
  report.checks[0].evidence = [];
  assert.equal(assessHarnessReport(report).status, "unknown");
  report.checks[0].evidence = [
    { uri: "https://github.com/o/r/actions/runs/1", sourceSha: "b".repeat(40) },
  ];
  assert.equal(assessHarnessReport(report).status, "unknown");
  report.checks[0].evidence[0].sourceSha = sha;
  report.checks[0].scope = "deployment";
  assert.equal(assessHarnessReport(report).status, "unknown");
  report.deploymentSha = sha;
  assert.equal(assessHarnessReport(report).status, "pass");
});

test("skipped required checks, quota gaps and empty requirements cannot imply completion", () => {
  const report = fixture();
  for (const status of ["unknown", "skipped"] as const) {
    report.checks[0].status = status;
    report.checks[0].reason = "quota_deferred_or_intentionally_paused";
    assert.equal(assessHarnessReport(report).status, "unknown");
  }
  report.checks[0].required = false;
  assert.equal(assessHarnessReport(report).status, "unknown");
  report.checks.push({ ...fixture().checks[0], id: "required" });
  assert.equal(assessHarnessReport(report).status, "pass");
  report.checks[1].status = "fail";
  assert.equal(assessHarnessReport(report).status, "fail");
  assert.deepEqual(
    (["pass", "fail", "unknown", "skipped"] as const).map(reportExitCode),
    [0, 1, 2, 2],
  );
});

test("untrusted reports reject missing fields, duplicate IDs, reversed time and unsafe evidence", () => {
  const report = fixture();
  assert.throws(() => parseHarnessReport({ ...report, baselineSha: undefined }));
  assert.throws(() => parseHarnessReport({ ...report, checks: [] }));
  assert.throws(() =>
    parseHarnessReport({ ...report, checks: [...report.checks, ...report.checks] }),
  );
  assert.throws(() => parseHarnessReport({ ...report, finishedAt: "2026-09-12T00:00:00Z" }));
  for (const uri of [
    "javascript:alert(1)",
    "../private",
    "/tmp/result",
    "https://user:secret@example.test/a",
  ]) {
    report.checks[0].evidence[0].uri = uri;
    assert.throws(() => parseHarnessReport(report));
  }
});
