import example from "../../.github/harness/loop.example.json";
import { parseLoopSpec } from "../../scripts/harness/loop/contract.js";
import type { CheckStatus, HarnessReport } from "../../scripts/harness/report.js";
export const loopSha = "a".repeat(40);
export const loopTime = (seconds = 0) =>
  new Date(Date.parse("2026-09-13T00:00:00Z") + seconds * 1000).toISOString();
export const loopSpec = () => parseLoopSpec({ ...example, baselineSha: loopSha });
export const loopCheckout = { sourceSha: loopSha, branch: "loop/test", dirty: false };
export const loopScope = {
  baselineSha: loopSha,
  sourceSha: loopSha,
  artifactUri: ".generated/scope.json",
  changes: [],
};
export function loopReport(status: CheckStatus = "pass", seconds = 2): HarnessReport {
  return {
    schemaVersion: 1,
    runId: `test-${seconds}`,
    sourceSha: loopSha,
    baselineSha: loopSha,
    deploymentSha: null,
    startedAt: loopTime(seconds),
    finishedAt: loopTime(seconds),
    checks: [
      {
        id: "source-checks",
        required: true,
        scope: "source",
        status,
        reason: "test outcome",
        evidence: [{ uri: ".generated/result.json", sourceSha: loopSha }],
      },
    ],
  };
}
