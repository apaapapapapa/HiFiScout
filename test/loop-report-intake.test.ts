import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReportIntake,
  signalsFromHarnessReport,
} from "../scripts/harness/loop/report-intake.js";
import { parseLoopSpec, pathAllowed } from "../scripts/harness/loop/contract.js";
import { loopReport } from "./helpers/loop.js";

const envelope = () => ({
  schemaVersion: 1,
  kind: "product",
  repository: "apaapapapapa/HiFiScout",
  evidenceUrl: "https://github.com/apaapapapapa/HiFiScout/actions/runs/1",
  report: loopReport("fail"),
});
test("only required, source-bound failures in the selected domain propose repair work", () => {
  const input = envelope();
  input.report.checks[0].id = "replay/identity";
  assert.equal(signalsFromHarnessReport(input).signals.length, 1);
  for (const status of ["pass", "unknown", "skipped"] as const) {
    input.report.checks[0].status = status;
    assert.equal(signalsFromHarnessReport(input).signals.length, 0);
  }
  input.report.checks[0].status = "fail";
  input.report.checks[0].required = false;
  assert.equal(signalsFromHarnessReport(input).signals.length, 0);
  input.report.checks[0].required = true;
  input.report.checks[0].evidence[0].sourceSha = "b".repeat(40);
  assert.equal(signalsFromHarnessReport(input).signals.length, 0);
  input.report.checks[0].evidence[0].sourceSha = input.report.sourceSha;
  input.report.checks[0].scope = "observation";
  assert.equal(signalsFromHarnessReport(input).signals.length, 0);
  input.report.checks[0].scope = "source";
  input.kind = "cost";
  assert.equal(signalsFromHarnessReport(input).signals.length, 0);
  assert.throws(
    () => signalsFromHarnessReport({ ...input, evidenceUrl: "http://example.com" }),
    /bounds_or_url/u,
  );
});

test("report intake deduplicates tasks and freezes domain gates without authorizing inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-report-intake-"));
  try {
    const input = envelope();
    input.kind = "ai";
    input.report.checks[0].id = "ai/offline-holdout";
    const first = await collectReportIntake(input, directory);
    input.report.checks[0].reason = "A later observation has different measurements";
    input.report.finishedAt = "2026-09-13T00:00:03.000Z";
    assert.deepEqual(await collectReportIntake(input, directory), first);
    const index = JSON.parse(await readFile(join(directory, "index.json"), "utf8"));
    assert.equal(index.items.length, 1);
    assert.equal(index.items[0].occurrences, 2);
    const spec = parseLoopSpec(
      JSON.parse(await readFile(join(directory, first.taskIds[0], "spec.json"), "utf8")),
    );
    assert.equal(spec.baselineSha, input.report.sourceSha);
    assert.ok(spec.task.requirements.some((r) => r.id === "ai/offline-holdout"));
    assert.equal(spec.budget.maxReservedCostMicros, 0);
    assert.equal(spec.delivery.target, "pr");
    assert.ok(pathAllowed(spec, "src/ai-suggestions/contract.ts"));
    assert.ok(!pathAllowed(spec, "src/worker.ts"));
    assert.ok(!pathAllowed(spec, "test/fixtures/ai-catalog-holdout.ts"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
