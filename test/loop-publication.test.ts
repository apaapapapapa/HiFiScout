import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loopGitFixture } from "./helpers/loop-git.js";
import { loopReport } from "./helpers/loop.js";
import { applyLoopPatch, prepareLoopWorkspace } from "../scripts/harness/loop/workspace.js";
import { beginLoopAttempt, finishLoopAttempt } from "../scripts/harness/loop/controller.js";
import { readLoopRun } from "../scripts/harness/loop/state.js";
import { loopStatus } from "../scripts/harness/loop/status.js";
import { collectLoopScope } from "../scripts/harness/loop/scope.js";
import {
  publishLoopPull,
  reviewLoopPull,
  mergeLoopPull,
  observeLoopDelivery,
} from "../scripts/harness/loop/publication.js";

async function fixture(target: "pr" | "merge", review: "self" | "optional") {
  const f = await loopGitFixture({ delivery: { target, review, reviewWaitMs: 900_000 } });
  await prepareLoopWorkspace(f.state, f.source, f.workspaces);
  await beginLoopAttempt(f.state, "Correct the value", { externalCalls: 1, reservedCostMicros: 0 });
  const patch =
    "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
  const applied = await applyLoopPatch(f.state, f.workspaces, 1, f.sha, patch);
  const run = await readLoopRun(f.state),
    at = new Date().toISOString();
  const scope = await collectLoopScope(run.spec, applied.workspace);
  const report = loopReport();
  report.sourceSha = applied.owner.headSha;
  report.baselineSha = f.sha;
  report.startedAt = at;
  report.finishedAt = at;
  report.checks[0].evidence[0].sourceSha = applied.owner.headSha;
  await finishLoopAttempt(f.state, report, applied.checkout, new Date().toISOString(), scope);
  const candidate = applied.owner.headSha,
    mergeSha = "b".repeat(40),
    repo = run.spec.repository;
  let exists = false,
    merged = false,
    mainCi = false,
    threads = false,
    remoteHead = candidate,
    resolvedSummarySha = candidate;
  let postFailure: "before" | "after" | null = null;
  const requests: { id: number; body: string }[] = [];
  const calls: string[][] = [],
    pushes: string[][] = [];
  const pull = () => ({
    number: 7,
    state: "open",
    merged,
    merge_commit_sha: merged ? mergeSha : null,
    head: { sha: remoteHead },
    base: { ref: "main", sha: f.sha },
  });
  const invoke = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "create") {
      assert.match(
        await readFile(args[args.indexOf("--body-file") + 1], "utf8"),
        new RegExp(candidate, "u"),
      );
      exists = true;
      return `https://github.com/${repo}/pull/7\n`;
    }
    if (args.includes("graphql"))
      return JSON.stringify([
        {
          data: {
            repository: {
              pullRequest: {
                headRefOid: remoteHead,
                reviewDecision: null,
                reviewThreads: {
                  nodes: threads ? [{ isResolved: false }] : [],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        },
      ]);
    const path = args.find((arg) => arg.startsWith("repos/"))!;
    if (path.endsWith("/issues/7/comments") && args.includes("POST")) {
      const failure = postFailure;
      postFailure = null;
      if (failure === "before") throw new Error("request_not_sent");
      const comment = { id: 11, body: args.find((arg) => arg.startsWith("body="))!.slice(5) };
      requests.push(comment);
      if (failure === "after") throw new Error("acknowledgement_lost");
      return JSON.stringify(comment);
    }
    if (path.endsWith("/pulls/7/merge")) {
      assert.ok(args.includes(`sha=${candidate}`));
      assert.ok(args.includes("merge_method=merge"));
      merged = true;
      return JSON.stringify({ merged, sha: mergeSha });
    }
    if (path.includes("/pulls?")) return JSON.stringify(exists ? [pull()] : []);
    if (path.endsWith("/pulls/7")) return JSON.stringify(pull());
    if (path.includes("/workflows/ci.yml/"))
      return JSON.stringify([
        {
          workflow_runs:
            !merged || mainCi
              ? [
                  {
                    id: 1,
                    head_sha: merged ? mergeSha : candidate,
                    head_branch: "main",
                    event: merged ? "push" : "pull_request",
                    path: ".github/workflows/ci.yml",
                    status: "completed",
                    conclusion: "success",
                  },
                ]
              : [],
        },
      ]);
    if (path.includes("/statuses?")) return "[[]]";
    if (path.includes("/reviews?")) return "[[]]";
    if (path.includes("/issues/7/comments?"))
      return JSON.stringify([
        [
          ...requests,
          {
            user: { login: "chatgpt-codex-connector[bot]" },
            updated_at: new Date().toISOString(),
            body: `<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit |\n| Code Review | ✅ **Completed** | \`${candidate.slice(0, 7)}\` |`,
          },
        ],
      ]);
    if (path.includes("/commits/")) return JSON.stringify({ sha: resolvedSummarySha });
    throw new Error(`unexpected_request:${path}`);
  };
  const push = (workspace: string, branch: string, sha: string, repository: string) => {
    pushes.push([workspace, branch, sha, repository]);
  };
  return {
    ...f,
    candidate,
    mergeSha,
    invoke,
    push,
    calls,
    pushes,
    requests,
    failRequest: (when: "before" | "after") => {
      exists = true;
      postFailure = when;
    },
    setMainCi: () => {
      mainCi = true;
    },
    setThreads: (value: boolean) => {
      threads = value;
    },
    setHead: (value: string) => {
      remoteHead = value;
    },
    setSummary: (value: string) => {
      resolvedSummarySha = value;
    },
  };
}

test("publication is idempotent and merge waits for current review gates and main CI", async () => {
  const f = await fixture("merge", "self");
  try {
    const published = await publishLoopPull(f.state, f.workspaces, f.invoke, f.push);
    await publishLoopPull(f.state, f.workspaces, f.invoke, f.push);
    assert.equal(f.pushes.length, 1);
    assert.equal(published.review?.prNumber, 7);
    const receipt = join(f.root, "self.json");
    await writeFile(
      receipt,
      JSON.stringify({
        sourceSha: f.candidate,
        method: "self",
        completedAt: new Date().toISOString(),
        summary: "Reviewed the source diff and verification evidence",
        reviewedPaths: ["src/value.ts"],
        unresolvedFindings: 0,
        artifactUri: ".generated/self.json",
      }),
    );
    await reviewLoopPull(f.state, f.workspaces, receipt, f.invoke);
    f.setThreads(true);
    await assert.rejects(mergeLoopPull(f.state, f.workspaces, f.invoke), /merge_gates_incomplete/u);
    assert.equal(f.calls.filter((c) => c.includes("PUT")).length, 0);
    f.setThreads(false);
    assert.equal((await mergeLoopPull(f.state, f.workspaces, f.invoke)).phase, "delivery");
    f.setMainCi();
    const completed = await observeLoopDelivery(f.state, f.workspaces, f.invoke);
    assert.equal(completed.phase, "completed");
    assert.equal(completed.lastDeliveryReport?.sourceSha, f.mergeSha);
    assert.deepEqual(loopStatus(await readLoopRun(f.state)).blockers, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Codex summaries resolve to the full reviewed SHA and a PR-only contract cannot merge", async () => {
  const f = await fixture("pr", "optional");
  try {
    await publishLoopPull(f.state, f.workspaces, f.invoke, f.push);
    f.setHead("d".repeat(40));
    await assert.rejects(
      reviewLoopPull(f.state, f.workspaces, undefined, f.invoke),
      /identity_mismatch/u,
    );
    f.setHead(f.candidate);
    f.setSummary("e".repeat(40));
    assert.equal(
      (await reviewLoopPull(f.state, f.workspaces, undefined, f.invoke)).phase,
      "review",
    );
    f.setSummary(f.candidate);
    assert.equal(
      (await reviewLoopPull(f.state, f.workspaces, undefined, f.invoke)).phase,
      "delivery",
    );
    await assert.rejects(mergeLoopPull(f.state, f.workspaces, f.invoke), /not_authorized/u);
    assert.equal((await observeLoopDelivery(f.state, f.workspaces, f.invoke)).phase, "completed");
    assert.deepEqual(loopStatus(await readLoopRun(f.state)).blockers, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("review request retries recover unsent requests and lost acknowledgements without a new deadline", async () => {
  for (const failure of ["before", "after"] as const) {
    const f = await fixture("pr", "optional");
    try {
      f.failRequest(failure);
      await assert.rejects(
        publishLoopPull(f.state, f.workspaces, f.invoke, f.push),
        /request_not_sent|acknowledgement_lost/u,
      );
      const requested = await readLoopRun(f.state);
      const event = requested.events.find((e) => e.type === "review-requested")!;
      await publishLoopPull(f.state, f.workspaces, f.invoke, f.push);
      await publishLoopPull(f.state, f.workspaces, f.invoke, f.push);
      const recovered = await readLoopRun(f.state);
      assert.equal(recovered.events.filter((e) => e.type === "review-requested").length, 1);
      assert.equal(recovered.events.find((e) => e.type === "review-requested")!.at, event.at);
      assert.equal(f.requests.length, 1);
      assert.equal(f.pushes.length, 1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
