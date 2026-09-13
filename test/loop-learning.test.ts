import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loopGitFixture } from "./helpers/loop-git.js";
import { loopReport } from "./helpers/loop.js";
import {
  prepareLoopWorkspace,
  applyLoopPatch,
  loopGit,
} from "../scripts/harness/loop/workspace.js";
import {
  beginLoopAttempt,
  finishLoopAttempt,
  recordLoopEvent,
} from "../scripts/harness/loop/controller.js";
import { readLoopRun } from "../scripts/harness/loop/state.js";
import { collectLoopScope } from "../scripts/harness/loop/scope.js";
import { proveLoopRegression, learnFromLoop } from "../scripts/harness/loop/learning.js";
import type { LoopCommand, LoopCommandResult } from "../scripts/harness/loop/command.js";

const proposal = {
  id: "value-regression",
  title: "Correct the value",
  testPath: "test/value-regression.test.ts",
  assertionName: "value equals two",
  sourceUrls: ["https://github.com/apaapapapapa/HiFiScout/issues/1"],
  labelReviewNotes: null,
  procedure: ["Reproduce the assertion on the old source", "Run the same assertion after the fix"],
};
async function fixture() {
  const f = await loopGitFixture({
    delivery: { target: "pr", review: "self", reviewWaitMs: 900_000 },
  });
  await prepareLoopWorkspace(f.state, f.source, f.workspaces);
  await beginLoopAttempt(f.state, "Fix and retain the failure", {
    externalCalls: 1,
    reservedCostMicros: 0,
  });
  const patch =
    "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n" +
    `diff --git a/${proposal.testPath} b/${proposal.testPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${proposal.testPath}\n@@ -0,0 +1,3 @@\n+import { test, expect } from "vite-plus/test";\n+import { value } from "../src/value.js";\n+test("value equals two", () => expect(value).toBe(2));\n`;
  const applied = await applyLoopPatch(f.state, f.workspaces, 1, f.sha, patch);
  const run = await readLoopRun(f.state),
    scope = await collectLoopScope(run.spec, applied.workspace);
  const report = loopReport(),
    at = new Date().toISOString();
  report.sourceSha = applied.owner.headSha;
  report.baselineSha = f.sha;
  report.startedAt = at;
  report.finishedAt = at;
  report.checks[0].evidence[0].sourceSha = applied.owner.headSha;
  await finishLoopAttempt(f.state, report, applied.checkout, at, scope);
  const invoke =
    (mode: "normal" | "baseline-pass" | "import-error" | "late-candidate-error") =>
    async (request: LoopCommand): Promise<LoopCommandResult> => {
      const startedAt = new Date().toISOString();
      await writeFile(request.logPath, "fixture runner evidence", { flag: "wx" });
      if (request.args[0] === "install")
        return {
          status: "pass",
          reason: "fixture_setup",
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      const baseline = request.cwd !== applied.workspace;
      const source = await readFile(join(request.cwd, "src/value.ts"), "utf8");
      const passed = source.includes("value = 2") || (baseline && mode === "baseline-pass");
      const status = passed ? "passed" : "failed";
      const assertions =
        baseline && mode === "import-error"
          ? []
          : [
              {
                fullName: proposal.assertionName,
                status,
                failureMessages: passed ? [] : ["Expected value=2, observed value=1"],
              },
            ];
      const data = {
        success: passed,
        testResults: [
          { name: join(request.cwd, proposal.testPath), status, assertionResults: assertions },
        ],
      };
      const output = request.args
        .find((a) => a.startsWith("--outputFile="))!
        .slice("--outputFile=".length);
      await writeFile(output, JSON.stringify(data), { flag: "wx" });
      return {
        status: passed && (baseline || mode !== "late-candidate-error") ? "pass" : "fail",
        reason: "fixture_assertion",
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    };
  const finish = async () => {
    const event = async (
      type: Parameters<typeof recordLoopEvent>[2],
      data: Record<string, unknown>,
    ) => recordLoopEvent(f.state, await readLoopRun(f.state), type, data);
    await event("review-requested", { prNumber: 1, sourceSha: applied.owner.headSha });
    await event("reviewed", {
      receipt: {
        sourceSha: applied.owner.headSha,
        method: "self",
        completedAt: new Date().toISOString(),
        summary: "Reviewed the source and regression",
        reviewedPaths: scope.changes.map((c) => c.path),
        unresolvedFindings: 0,
        artifactUri: ".generated/review.json",
      },
    });
    const pull = {
      number: 1,
      merged: false,
      merge_commit_sha: null,
      head: { sha: applied.owner.headSha },
      base: { ref: "main", sha: f.sha },
    };
    await event("delivery-observed", {
      snapshot: {
        repository: run.spec.repository,
        collectedAt: new Date().toISOString(),
        pull,
        pullAfter: pull,
        reviewPages: [
          {
            data: {
              repository: {
                pullRequest: {
                  headRefOid: applied.owner.headSha,
                  reviewDecision: null,
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
                },
              },
            },
          },
        ],
        ciRuns: [
          {
            id: 1,
            head_sha: applied.owner.headSha,
            path: ".github/workflows/ci.yml",
            event: "pull_request",
            status: "completed",
            conclusion: "success",
          },
        ],
        statuses: [],
        deployment: null,
        downstream: [],
      },
    });
  };
  return { ...f, ...applied, invoke, finish };
}

test("only a reproduced assertion can become an idempotent regression lesson after delivery", async () => {
  const f = await fixture();
  try {
    const proof = await proveLoopRegression(f.state, f.workspaces, proposal, f.invoke("normal"));
    assert.equal(proof.proof.baselineSha, f.sha);
    assert.equal(proof.proof.sourceSha, f.owner.headSha);
    const index = join(f.root, "knowledge.json");
    await assert.rejects(
      learnFromLoop(f.state, f.workspaces, proposal, index),
      /completed_verified_delivery/u,
    );
    await f.finish();
    const lesson = await learnFromLoop(f.state, f.workspaces, proposal, index);
    assert.equal(lesson.record.pool, "regression-only");
    assert.equal(lesson.record.independentLabelReview, "not-recorded");
    assert.equal(lesson.record.procedureAuthority, "reference-data-only");
    assert.equal((await learnFromLoop(f.state, f.workspaces, proposal, index)).id, lesson.id);
    assert.equal(JSON.parse(await readFile(index, "utf8")).revision, 1);
    await assert.rejects(
      learnFromLoop(f.state, f.workspaces, { ...proposal, procedure: ["changed"] }, index),
      /proof_identity/u,
    );
    await writeFile(join(f.workspace, proof.proof.reportDirectory, "candidate-vitest.json"), "{}");
    await assert.rejects(
      learnFromLoop(f.state, f.workspaces, proposal, index),
      /report_changed_or_incomplete/u,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("passing baselines, import errors and late process failures cannot prove a regression fix", async () => {
  for (const mode of ["baseline-pass", "import-error", "late-candidate-error"] as const) {
    const f = await fixture();
    try {
      await assert.rejects(
        proveLoopRegression(f.state, f.workspaces, proposal, f.invoke(mode)),
        /not_reproduced_and_fixed/u,
      );
      assert.ok(
        !loopGit(f.workspace, ["worktree", "list", "--porcelain"]).includes(".regression-"),
      );
      const recovered = await proveLoopRegression(
        f.state,
        f.workspaces,
        proposal,
        f.invoke("normal"),
      );
      assert.equal(recovered.proof.sourceSha, f.owner.headSha);
      const artifacts = await readdir(
        join(f.workspace, ".generated/loop/learning/value-regression"),
      );
      assert.equal(artifacts.filter((name) => name.startsWith("attempt-")).length, 2);
      assert.ok(artifacts.includes("proof.json"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
