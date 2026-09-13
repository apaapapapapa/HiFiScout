import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessCheckpoint, saveCheckpoint } from "../scripts/harness/checkpoint.js";

const sha = "a".repeat(40);
const checkout = { sourceSha: sha, branch: "feature", dirty: false };
const task = {
  id: "issue-1",
  goal: "Preserve grouping",
  requirements: [{ id: "semantic", scope: "source" }],
  constraints: ["Do not enable paused audits"],
  nextActions: ["Review failed cases"],
};
const report = {
  schemaVersion: 1,
  runId: "fixture",
  sourceSha: sha,
  baselineSha: null,
  deploymentSha: null,
  startedAt: "2026-09-13T00:00:00Z",
  finishedAt: "2026-09-13T00:01:00Z",
  checks: [
    {
      id: "semantic",
      scope: "source",
      required: false,
      status: "pass",
      reason: "replayed",
      evidence: [{ uri: ".generated/cases.json", sourceSha: sha }],
    },
  ],
};

test("resume reevaluates fixed acceptance conditions against the current checkout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-checkpoint-"));
  try {
    const path = join(dir, "state.json");
    assert.equal((await saveCheckpoint(task, report, path, 0, checkout)).status, "pass");
    const state: unknown = JSON.parse(await readFile(path, "utf8"));
    assert.equal(assessCheckpoint(state, { ...checkout, dirty: true }).status, "unknown");
    assert.equal(
      assessCheckpoint(state, { ...checkout, sourceSha: "b".repeat(40) }).status,
      "unknown",
    );
    const incomplete = { ...report, checks: [{ ...report.checks[0], id: "other" }] };
    assert.equal((await saveCheckpoint(task, incomplete, path, 1, checkout)).status, "unknown");
    const failed = { ...report, checks: [{ ...report.checks[0], status: "fail" }] };
    assert.equal((await saveCheckpoint(task, failed, path, 2, checkout)).status, "fail");
    const unstable = {
      ...report,
      checks: [
        ...report.checks,
        {
          ...report.checks[0],
          id: "snapshot-stable",
          required: true,
          status: "unknown",
          reason: "PR changed during collection",
        },
      ],
    };
    const resumed = await saveCheckpoint(task, unstable, path, 3, checkout);
    assert.equal(resumed.status, "unknown");
    assert.deepEqual(resumed.remaining, ["snapshot-stable"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkpoint updates detect concurrent revisions, scope changes and writer locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-checkpoint-"));
  try {
    const path = join(dir, "state.json");
    await saveCheckpoint(task, report, path, 0, checkout);
    const original = await readFile(path, "utf8");
    await assert.rejects(saveCheckpoint(task, report, path, 0, checkout), /revision_conflict/u);
    await assert.rejects(
      saveCheckpoint({ ...task, goal: "Changed scope" }, report, path, 1, checkout),
      /scope_changed/u,
    );
    await writeFile(path + ".lock", "another writer");
    await assert.rejects(saveCheckpoint(task, report, path, 1, checkout), /EEXIST/u);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(await readFile(path + ".lock", "utf8"), "another writer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
