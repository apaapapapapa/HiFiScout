import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ingestLoopSignal,
  signalsFromCi,
  signalKey,
  specFromSignal,
} from "../scripts/harness/loop/intake.js";
import { loopSha, loopTime } from "./helpers/loop.js";
const repo = "apaapapapapa/HiFiScout";
const run = {
  id: 123,
  path: ".github/workflows/ci.yml",
  repository: { full_name: repo },
  head_repository: { full_name: repo },
  head_sha: loopSha,
  head_branch: "main",
  status: "completed",
  conclusion: "failure",
  updated_at: loopTime(),
};
const jobs = {
  total_count: 3,
  jobs: [
    { name: "unit-test (1)", conclusion: "failure" },
    { name: "build", conclusion: "success" },
    { name: "fan-out", conclusion: "failure" },
  ],
};

test("CI intake distinguishes failed jobs, self-generated runs, foreign sources and incomplete evidence", () => {
  const result = signalsFromCi(repo, run, jobs);
  assert.equal(result.signals.length, 1);
  assert.equal(
    signalsFromCi(repo, { ...run, head_branch: "automation/loop/loop-ci-123" }, jobs).reason,
    "existing_loop_owns_this_ci",
  );
  assert.equal(
    signalsFromCi(repo, { ...run, head_repository: { full_name: "fork/repo" } }, jobs).reason,
    "foreign_repository",
  );
  assert.throws(() => signalsFromCi(repo, run, { ...jobs, total_count: 4 }), /incomplete_ci_jobs/u);
  assert.throws(
    () => signalsFromCi(repo, run, { total_count: 0, jobs: [] }),
    /no_failed_job_evidence/u,
  );
  assert.equal(signalsFromCi(repo, { ...run, conclusion: "success" }, jobs).signals.length, 0);
});

test("repeat signals share a stable task without resetting its baseline or time order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-intake-"));
  try {
    const signal = signalsFromCi(repo, run, jobs).signals[0],
      index = join(dir, "index.json");
    const first = await ingestLoopSignal(signal, index);
    const newer = {
      ...signal,
      observedAt: loopTime(10),
      evidenceUrl: `https://github.com/${repo}/actions/runs/456`,
    };
    assert.equal((await ingestLoopSignal(newer, index)).occurrences, 2);
    const late = await ingestLoopSignal(signal, index);
    assert.equal(late.lastSeen, loopTime(10));
    assert.equal(late.occurrences, 3);
    assert.equal(specFromSignal(first.signal).task.id, specFromSignal(newer).task.id);
    assert.notEqual(signalKey(signal), signalKey({ ...signal, sourceSha: "b".repeat(40) }));
    assert.deepEqual(specFromSignal({ ...signal, kind: "cost" }).comparisons, ["cost"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
