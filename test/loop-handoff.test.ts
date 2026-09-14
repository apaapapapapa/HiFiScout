import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loopGitFixture } from "./helpers/loop-git.js";
import { loopReport, loopSpec } from "./helpers/loop.js";
import {
  adoptLoopCommit,
  applyLoopPatch,
  loopGit,
  prepareLoopWorkspace,
} from "../scripts/harness/loop/workspace.js";
import { beginLoopAttempt, finishLoopAttempt } from "../scripts/harness/loop/controller.js";
import { collectLoopScope } from "../scripts/harness/loop/scope.js";
import { readLoopRun } from "../scripts/harness/loop/state.js";
import { importLoopHandoff } from "../scripts/harness/loop/handoff.js";

const pullUrl = "https://api.github.com/repos/apaapapapapa/HiFiScout/pulls/7";
const reviewSource = { reviewSubmissionsUrl: `${pullUrl}/reviews`, reviewSubmissions: [] };

async function fixture(review: "self" | "optional" = "self") {
  const f = await loopGitFixture({ delivery: { target: "merge", review, reviewWaitMs: 900_000 } });
  await prepareLoopWorkspace(f.state, f.source, f.workspaces);
  await beginLoopAttempt(f.state, "Correct the value", { externalCalls: 1, reservedCostMicros: 0 });
  const applied = await applyLoopPatch(
    f.state,
    f.workspaces,
    1,
    f.sha,
    "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
  );
  return { ...f, ...applied };
}

test("connector commit adoption preserves tree and parent identity and requires fresh evaluation", async () => {
  const f = await fixture();
  try {
    const local = f.owner.headSha;
    const remote = loopGit(f.workspace, [
      "commit-tree",
      `${local}^{tree}`,
      "-p",
      f.sha,
      "-m",
      "Connector commit",
    ]);
    const wrongParent = loopGit(f.workspace, [
      "commit-tree",
      `${local}^{tree}`,
      "-p",
      local,
      "-m",
      "Wrong parent",
    ]);
    await assert.rejects(
      adoptLoopCommit(f.state, f.workspaces, local, wrongParent),
      /tree_or_parents/u,
    );
    await assert.rejects(adoptLoopCommit(f.state, f.workspaces, local, f.sha), /tree_or_parents/u);
    const adopted = await adoptLoopCommit(f.state, f.workspaces, local, remote);
    assert.equal(adopted.checkout.sourceSha, remote);
    assert.equal(
      (await adoptLoopCommit(f.state, f.workspaces, local, remote)).owner.revision,
      adopted.owner.revision,
    );
    await mkdir(join(f.workspace, ".generated/loop/attempt-1"), { recursive: true });
    await assert.rejects(
      adoptLoopCommit(f.state, f.workspaces, local, remote),
      /after_evaluation/u,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

async function verified(review: "self" | "optional" = "self") {
  const f = await fixture(review);
  const at = new Date().toISOString();
  const scope = await collectLoopScope((await readLoopRun(f.state)).spec, f.workspace);
  const report = loopReport();
  report.sourceSha = f.owner.headSha;
  report.baselineSha = f.sha;
  report.startedAt = at;
  report.finishedAt = at;
  report.checks[0].evidence[0].sourceSha = f.owner.headSha;
  await finishLoopAttempt(f.state, report, f.checkout, at, scope);
  return f;
}

function snapshot(
  f: Awaited<ReturnType<typeof verified>>,
  options: { merged?: boolean; ci?: boolean; unresolved?: boolean } = {},
) {
  const head = f.owner.headSha;
  const pull = {
    number: 7,
    state: options.merged ? "closed" : "open",
    merged: !!options.merged,
    merge_commit_sha: options.merged ? "b".repeat(40) : null,
    head: {
      sha: head,
      ref: `automation/loop/${loopSpec().task.id}`,
      repo: { full_name: "apaapapapapa/HiFiScout" },
    },
    base: { ref: "main", sha: f.sha },
  };
  return {
    repository: "apaapapapapa/HiFiScout",
    collectedAt: new Date().toISOString(),
    pull,
    pullAfter: structuredClone(pull),
    reviewPages: [
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: head,
              reviewDecision: null,
              reviewThreads: {
                nodes: options.unresolved ? [{ isResolved: false }] : [],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      },
    ],
    ciRuns:
      options.ci === false
        ? []
        : [
            {
              id: 1,
              head_sha: options.merged ? pull.merge_commit_sha : head,
              head_branch: "main",
              event: options.merged ? "push" : "pull_request",
              path: ".github/workflows/ci.yml",
              status: "completed",
              conclusion: "success",
            },
          ],
    statuses: [],
    deployment: null,
    downstream: [],
  };
}

test("native handoff gates current evidence and completes only after merge SHA CI", async () => {
  const f = await verified();
  const handoff = (
    action: "publish" | "review" | "merge-ready" | "observe",
    input: Record<string, unknown>,
  ) => importLoopHandoff(f.state, f.workspaces, action, { ...reviewSource, ...input });
  try {
    const stale = snapshot(f);
    stale.collectedAt = "2000-01-01T00:00:00Z";
    await assert.rejects(handoff("publish", { snapshot: stale }), /not_fresh/u);
    const moved = snapshot(f);
    moved.pullAfter.head.sha = "c".repeat(40);
    await assert.rejects(handoff("publish", { snapshot: moved }), /gates_incomplete/u);
    const published = await handoff("publish", { snapshot: snapshot(f) });
    await handoff("publish", { snapshot: snapshot(f) });
    assert.equal(
      (await readLoopRun(f.state)).events.filter((e) => e.type === "review-requested").length,
      1,
    );
    assert.ok("phase" in published);
    const receipt = {
      sourceSha: f.owner.headSha,
      method: "self",
      completedAt: new Date().toISOString(),
      summary: "Reviewed value change and tests",
      reviewedPaths: ["src/value.ts"],
      unresolvedFindings: 0,
      artifactUri: ".generated/self.json",
    };
    await assert.rejects(
      handoff("review", { snapshot: snapshot(f, { unresolved: true }), receipt }),
      /gates_incomplete/u,
    );
    await assert.rejects(
      handoff("review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt: { ...receipt, reviewedPaths: [] },
      }),
      /cover_changed_paths/u,
    );
    await assert.rejects(
      handoff("review", { snapshot: snapshot(f, { merged: true }), receipt }),
      /open_unmerged/u,
    );
    const closed = snapshot(f);
    closed.pull.state = "closed";
    closed.pullAfter.state = "closed";
    await assert.rejects(handoff("review", { snapshot: closed, receipt }), /open_unmerged/u);
    await assert.rejects(
      handoff("review", {
        snapshot: snapshot(f),
        receipt,
        reviewSubmissionsUrl: `${pullUrl}0/reviews`,
      }),
      /collection_missing/u,
    );
    await assert.rejects(
      handoff("review", {
        snapshot: snapshot(f),
        receipt,
        reviewSubmissions: [
          {
            id: 1,
            user: { login: "reviewer" },
            state: "APPROVED",
            pull_request_url: `${pullUrl}0`,
          },
        ],
      }),
      /invalid_handoff_review_submission/u,
    );
    await handoff("review", { snapshot: snapshot(f), receipt });
    await assert.rejects(
      handoff("merge-ready", { snapshot: snapshot(f, { merged: true }) }),
      /open_unmerged/u,
    );
    await assert.rejects(
      handoff("merge-ready", { snapshot: snapshot(f, { ci: false }) }),
      /gates_incomplete/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: snapshot(f),
        reviewSubmissions: [
          {
            id: 1,
            user: { login: "reviewer" },
            state: "CHANGES_REQUESTED",
            pull_request_url: pullUrl,
          },
          { id: 2, user: { login: "reviewer" }, state: "COMMENTED", pull_request_url: pullUrl },
        ],
      }),
      /changes_requested/u,
    );
    const ready = await handoff("merge-ready", { snapshot: snapshot(f) });
    assert.ok("expectedHeadSha" in ready && ready.expectedHeadSha === f.owner.headSha);
    assert.equal(
      (await handoff("observe", { snapshot: snapshot(f, { merged: true, ci: false }) })).phase,
      "delivery",
    );
    assert.equal(
      (await handoff("observe", { snapshot: snapshot(f, { merged: true }) })).phase,
      "completed",
    );
    await assert.rejects(
      adoptLoopCommit(f.state, f.workspaces, f.owner.headSha, f.sha),
      /active_attempt/u,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("handoff cannot invent a Codex review or bypass optional review wait", async () => {
  const f = await verified("optional");
  try {
    await importLoopHandoff(f.state, f.workspaces, "publish", { snapshot: snapshot(f) });
    const receipt = {
      sourceSha: f.owner.headSha,
      method: "self",
      completedAt: new Date().toISOString(),
      summary: "Review",
      reviewedPaths: ["src/value.ts"],
      unresolvedFindings: 0,
      artifactUri: ".generated/review.json",
    };
    await assert.rejects(
      importLoopHandoff(f.state, f.workspaces, "review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt,
      }),
      /wait_not_expired/u,
    );
    await assert.rejects(
      importLoopHandoff(f.state, f.workspaces, "review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt: { ...receipt, method: "codex" },
      }),
      /codex_review_missing/u,
    );
    const codexReview = {
      id: 3,
      pull_request_url: pullUrl,
      user: { login: "chatgpt-codex-connector[bot]" },
      commit_id: f.owner.headSha,
      state: "COMMENTED",
      submitted_at: receipt.completedAt,
    };
    await assert.rejects(
      importLoopHandoff(f.state, f.workspaces, "review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt: { ...receipt, method: "codex" },
        codexReview: { ...codexReview, pull_request_url: `${pullUrl}0` },
      }),
      /codex_review_missing/u,
    );
    await assert.rejects(
      importLoopHandoff(f.state, f.workspaces, "review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt: { ...receipt, method: "codex" },
        codexReview,
      }),
      /codex_review_missing/u,
    );
    assert.equal(
      (
        await importLoopHandoff(f.state, f.workspaces, "review", {
          ...reviewSource,
          reviewSubmissions: [codexReview],
          snapshot: snapshot(f),
          receipt: { ...receipt, method: "codex" },
          codexReview,
        })
      ).phase,
      "delivery",
    );
    await writeFile(join(f.workspace, "src/value.ts"), "export const value = 3;\n");
    await assert.rejects(
      importLoopHandoff(f.state, f.workspaces, "review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt: { ...receipt, method: "codex" },
        codexReview,
      }),
      /checkout_changed/u,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
