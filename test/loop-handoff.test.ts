import { test, vi } from "vite-plus/test";
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
import { importLoopHandoff, type LoopHandoff } from "../scripts/harness/loop/handoff.js";

const pullUrl = "https://api.github.com/repos/apaapapapapa/HiFiScout/pulls/7";
const reviewSource = {
  reviewSubmissionPages: [{ url: `${pullUrl}/reviews?per_page=100&page=1`, items: [] }],
};
const reviewPage = (items: unknown[], page = 1) => ({
  url: `${pullUrl}/reviews?per_page=100&page=${page}`,
  items,
});

function handoffInput(input: Record<string, unknown>) {
  const value = input.snapshot as ReturnType<typeof snapshot>;
  const repoUrl = "https://api.github.com/repos/apaapapapapa/HiFiScout";
  const source = value.pull.merged ? value.pull.merge_commit_sha : value.pull.head.sha;
  const event = value.pull.merged ? "push" : "pull_request";
  return {
    ...reviewSource,
    workflowRunPages: [
      {
        url: `${repoUrl}/actions/runs?head_sha=${source}&event=${event}&per_page=100&page=1`,
        response: { total_count: value.ciRuns.length, workflow_runs: value.ciRuns },
      },
    ],
    statusPages: [
      {
        url: `${repoUrl}/commits/${source}/statuses?per_page=100&page=1`,
        items: value.statuses,
      },
    ],
    ...input,
  };
}

async function fixture(
  review: "self" | "optional" = "self",
  target: "merge" | "deployment" = "merge",
) {
  const f = await loopGitFixture({ delivery: { target, review, reviewWaitMs: 900_000 } });
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
    vi.useRealTimers();
    await rm(f.root, { recursive: true, force: true });
  }
});

async function verified(
  review: "self" | "optional" = "self",
  target: "merge" | "deployment" = "merge",
) {
  const f = await fixture(review, target);
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
    url: pullUrl,
    state: options.merged ? "closed" : "open",
    merged: !!options.merged,
    merge_commit_sha: options.merged ? "b".repeat(40) : null,
    head: {
      sha: head,
      ref: `automation/loop/${loopSpec().task.id}`,
      repo: { full_name: "apaapapapapa/HiFiScout" },
    },
    base: { ref: "main", sha: f.sha, repo: { full_name: "apaapapapapa/HiFiScout" } },
  };
  return {
    repository: "apaapapapapa/HiFiScout",
    collectedAt: new Date().toISOString(),
    pull,
    pullAfter: structuredClone(pull),
    reviewPages: [
      {
        after: null as string | null,
        data: {
          repository: {
            nameWithOwner: "apaapapapapa/HiFiScout",
            pullRequest: {
              number: 7,
              url: "https://github.com/apaapapapapa/HiFiScout/pull/7",
              headRefOid: head,
              reviewDecision: null,
              reviewThreads: {
                nodes: options.unresolved ? [{ id: "thread-1", isResolved: false }] : [],
                pageInfo: { hasNextPage: false, endCursor: null as string | null },
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
              url: "https://api.github.com/repos/apaapapapapa/HiFiScout/actions/runs/1",
              repository: { full_name: "apaapapapapa/HiFiScout" },
              head_repository: { full_name: "apaapapapapa/HiFiScout" },
              pull_requests: options.merged
                ? []
                : [
                    {
                      number: 7,
                      url: pullUrl,
                      head: {
                        ref: pull.head.ref,
                        sha: head,
                        repo: { url: "https://api.github.com/repos/apaapapapapa/HiFiScout" },
                      },
                      base: {
                        ref: "main",
                        repo: { url: "https://api.github.com/repos/apaapapapapa/HiFiScout" },
                      },
                    },
                  ],
              head_branch: options.merged ? "main" : pull.head.ref,
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
  ) => importLoopHandoff(f.state, f.workspaces, action, handoffInput(input));
  try {
    const stale = snapshot(f);
    stale.collectedAt = "2000-01-01T00:00:00Z";
    await assert.rejects(handoff("publish", { snapshot: stale }), /not_fresh/u);
    const moved = snapshot(f);
    moved.pullAfter.head.sha = "c".repeat(40);
    await assert.rejects(handoff("publish", { snapshot: moved }), /pull_identity_mismatch/u);
    const foreignThreads = snapshot(f);
    foreignThreads.reviewPages[0].data.repository.pullRequest.number = 8;
    await assert.rejects(handoff("publish", { snapshot: foreignThreads }), /thread_page_identity/u);
    foreignThreads.reviewPages[0].data.repository.pullRequest.number = 7;
    foreignThreads.reviewPages[0].data.repository.nameWithOwner = "other/repo";
    await assert.rejects(handoff("publish", { snapshot: foreignThreads }), /thread_page_identity/u);
    const pages = snapshot(f);
    pages.reviewPages[0].data.repository.pullRequest.reviewThreads = {
      nodes: [{ id: "thread-1", isResolved: true }],
      pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
    };
    const lastPage = snapshot(f).reviewPages[0];
    lastPage.after = "wrong-cursor";
    pages.reviewPages.push(lastPage);
    await assert.rejects(handoff("publish", { snapshot: pages }), /thread_page_identity/u);
    lastPage.after = "cursor-1";
    lastPage.data.repository.pullRequest.reviewThreads.nodes.push({
      id: "thread-1",
      isResolved: true,
    });
    await assert.rejects(handoff("publish", { snapshot: pages }), /pagination_changed/u);
    lastPage.data.repository.pullRequest.reviewThreads.nodes = [];
    const published = await handoff("publish", { snapshot: pages });
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
        reviewSubmissionPages: [{ url: `${pullUrl}0/reviews?per_page=100&page=1`, items: [] }],
      }),
      /pagination_incomplete/u,
    );
    await assert.rejects(
      handoff("review", {
        snapshot: snapshot(f),
        receipt,
        reviewSubmissionPages: [
          reviewPage([
            {
              id: 1,
              user: { login: "reviewer" },
              state: "APPROVED",
              pull_request_url: `${pullUrl}0`,
            },
          ]),
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
        reviewSubmissionPages: [
          reviewPage([
            {
              id: 1,
              user: { login: "reviewer" },
              state: "CHANGES_REQUESTED",
              pull_request_url: pullUrl,
            },
            { id: 2, user: { login: "reviewer" }, state: "COMMENTED", pull_request_url: pullUrl },
          ]),
        ],
      }),
      /changes_requested/u,
    );
    for (const change of [
      (pull: ReturnType<typeof snapshot>["pull"]) => {
        pull.base.ref = "release";
      },
      (pull: ReturnType<typeof snapshot>["pull"]) => {
        pull.base.repo.full_name = "other/repo";
      },
      (pull: ReturnType<typeof snapshot>["pull"]) => {
        pull.base.sha = "d".repeat(40);
      },
      (pull: ReturnType<typeof snapshot>["pull"]) => {
        pull.number = 8;
      },
      (pull: ReturnType<typeof snapshot>["pull"]) => {
        pull.state = "closed";
      },
    ]) {
      const changed = snapshot(f);
      change(changed.pullAfter);
      await assert.rejects(
        handoff("merge-ready", { snapshot: changed }),
        /pull_identity_mismatch/u,
      );
    }
    const foreignRun = snapshot(f);
    foreignRun.ciRuns[0].repository.full_name = "other/repo";
    await assert.rejects(
      handoff("merge-ready", { snapshot: foreignRun }),
      /run_repository_mismatch/u,
    );
    const otherPull = snapshot(f);
    otherPull.ciRuns[0].pull_requests[0].number = 8;
    await assert.rejects(handoff("merge-ready", { snapshot: otherPull }), /ci_pull_mismatch/u);
    otherPull.ciRuns[0].pull_requests = [];
    await assert.rejects(handoff("merge-ready", { snapshot: otherPull }), /ci_pull_mismatch/u);
    const duplicateRun = snapshot(f);
    duplicateRun.ciRuns.push(duplicateRun.ciRuns[0]);
    await assert.rejects(
      handoff("merge-ready", { snapshot: duplicateRun }),
      /workflow_pagination_changed/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: {
          ...snapshot(f),
          statuses: [
            {
              id: 1,
              url: `https://api.github.com/repos/other/repo/statuses/${f.owner.headSha}`,
              state: "success",
              context: "deployment/cloudflare",
            },
          ],
        },
      }),
      /status_source_mismatch/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: {
          ...snapshot(f),
          deployment: {
            run: {
              id: 2,
              repository: { full_name: "other/repo" },
              url: "https://api.github.com/repos/other/repo/actions/runs/2",
            },
            artifact: {},
            sourceSha: f.owner.headSha,
          },
        },
      }),
      /run_repository_mismatch/u,
    );
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      user: { login: "reviewer" },
      state: "COMMENTED",
      pull_request_url: pullUrl,
    }));
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: snapshot(f),
        reviewSubmissionPages: [reviewPage(firstPage)],
      }),
      /pagination_incomplete/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: snapshot(f),
        reviewSubmissionPages: [reviewPage(firstPage), reviewPage([], 3)],
      }),
      /pagination_incomplete/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: snapshot(f),
        reviewSubmissionPages: [reviewPage(firstPage), reviewPage([firstPage[0]], 2)],
      }),
      /pagination_changed/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: snapshot(f),
        reviewSubmissionPages: [
          reviewPage(firstPage),
          reviewPage(
            [
              {
                id: 101,
                user: { login: "reviewer" },
                state: "CHANGES_REQUESTED",
                pull_request_url: pullUrl,
              },
            ],
            2,
          ),
        ],
      }),
      /changes_requested/u,
    );
    const ready = await handoff("merge-ready", {
      snapshot: snapshot(f),
      reviewSubmissionPages: [reviewPage(firstPage), reviewPage([], 2)],
    });
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
    vi.useRealTimers();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("native handoff requires complete workflow and status pages matching the snapshot", async () => {
  const f = await verified();
  const handoff = (action: LoopHandoff, input: Record<string, unknown>) =>
    importLoopHandoff(f.state, f.workspaces, action, handoffInput(input));
  try {
    await handoff("publish", { snapshot: snapshot(f) });
    await handoff("review", {
      snapshot: snapshot(f),
      receipt: {
        sourceSha: f.owner.headSha,
        method: "self",
        completedAt: new Date().toISOString(),
        summary: "Reviewed value change and tests",
        reviewedPaths: ["src/value.ts"],
        unresolvedFindings: 0,
        artifactUri: ".generated/self.json",
      },
    });
    const value = snapshot(f);
    const collected = handoffInput({ snapshot: value });
    const page = collected.workflowRunPages[0];
    await assert.rejects(
      handoff("merge-ready", { snapshot: value, workflowRunPages: undefined }),
      /workflow_collection_missing/u,
    );
    await assert.rejects(
      handoff("merge-ready", { snapshot: value, statusPages: undefined }),
      /status_collection_missing/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: value,
        workflowRunPages: [{ ...page, response: { ...page.response, total_count: 2 } }],
      }),
      /workflow_pagination_incomplete/u,
    );
    const runs = Array.from({ length: 101 }, (_, index) => ({
      ...value.ciRuns[0],
      id: index + 1,
      url: `https://api.github.com/repos/apaapapapapa/HiFiScout/actions/runs/${index + 1}`,
      path: index === 0 ? ".github/workflows/secret-scan.yml" : ".github/workflows/ci.yml",
      conclusion: index === 100 ? "failure" : "success",
    }));
    const workflowRunPages = [
      { ...page, response: { total_count: 101, workflow_runs: runs.slice(0, 100) } },
      {
        url: page.url.replace("&page=1", "&page=2"),
        response: { total_count: 101, workflow_runs: runs.slice(100) },
      },
    ];
    const complete = { ...value, ciRuns: runs.slice(1) };
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: complete,
        workflowRunPages: workflowRunPages.slice(0, 1),
      }),
      /workflow_pagination_incomplete/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: complete,
        workflowRunPages: [...workflowRunPages].reverse(),
      }),
      /workflow_pagination_incomplete/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: complete,
        workflowRunPages: [
          workflowRunPages[0],
          {
            ...workflowRunPages[1],
            response: { total_count: 100, workflow_runs: runs.slice(100) },
          },
        ],
      }),
      /workflow_pagination_incomplete/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: { ...complete, ciRuns: runs.slice(1, 100) },
        workflowRunPages,
      }),
      /collection_snapshot_mismatch/u,
    );
    await assert.rejects(
      handoff("merge-ready", { snapshot: complete, workflowRunPages }),
      /gates_incomplete/u,
    );
    runs[100].conclusion = "success";
    assert.ok(
      "expectedHeadSha" in (await handoff("merge-ready", { snapshot: complete, workflowRunPages })),
    );

    const statusUrl = collected.statusPages[0].url;
    const statuses = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      url: `https://api.github.com/repos/apaapapapapa/HiFiScout/statuses/${f.owner.headSha}`,
      state: "success",
      context: "deployment/cloudflare",
    }));
    const statusPage = { url: statusUrl, items: statuses };
    await assert.rejects(
      handoff("merge-ready", { snapshot: { ...value, statuses }, statusPages: [statusPage] }),
      /status_pagination_incomplete/u,
    );
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: { ...value, statuses },
        statusPages: [statusPage, { url: statusUrl.replace("&page=1", "&page=3"), items: [] }],
      }),
      /status_pagination_incomplete/u,
    );
    const latest = { ...statuses[99], id: 101, state: "pending" };
    await assert.rejects(
      handoff("merge-ready", {
        snapshot: { ...value, statuses },
        statusPages: [
          statusPage,
          { url: statusUrl.replace("&page=1", "&page=2"), items: [latest] },
        ],
      }),
      /collection_snapshot_mismatch/u,
    );
    assert.ok(
      "expectedHeadSha" in
        (await handoff("merge-ready", {
          snapshot: { ...value, statuses },
          statusPages: [statusPage, { url: statusUrl.replace("&page=1", "&page=2"), items: [] }],
        })),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("deployment handoff binds version and receipts to retained artifact files", async () => {
  const f = await verified("self", "deployment");
  const handoff = (action: LoopHandoff, input: Record<string, unknown>) =>
    importLoopHandoff(f.state, f.workspaces, action, handoffInput(input));
  try {
    await handoff("publish", { snapshot: snapshot(f) });
    await handoff("review", {
      snapshot: snapshot(f),
      receipt: {
        sourceSha: f.owner.headSha,
        method: "self",
        completedAt: new Date().toISOString(),
        summary: "Reviewed value change and tests",
        reviewedPaths: ["src/value.ts"],
        unresolvedFindings: 0,
        artifactUri: ".generated/self.json",
      },
    });
    const repoUrl = "https://api.github.com/repos/apaapapapapa/HiFiScout";
    const sourceSha = "b".repeat(40);
    const run = (id: number, path: string) => ({
      id,
      path,
      url: `${repoUrl}/actions/runs/${id}`,
      repository: { full_name: "apaapapapapa/HiFiScout" },
      event: "workflow_run",
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
    });
    const artifact = (id: number, name: string) => ({
      id,
      name,
      url: `${repoUrl}/actions/artifacts/${id}`,
      expired: false,
      workflow_run: { id },
    });
    const deployed = {
      ...snapshot(f, { merged: true }),
      statuses: ["deployment/cloudflare", "deployment/catalog-admin", "verification/e2e"].map(
        (context, index) => ({
          id: index + 1,
          context,
          state: "success",
          description: "Verified",
          url: `${repoUrl}/statuses/${sourceSha}`,
          target_url: `https://github.com/apaapapapapa/HiFiScout/actions/runs/${10 + index}`,
        }),
      ),
      deployment: {
        run: run(10, ".github/workflows/deploy.yml"),
        artifact: artifact(10, "deployment-identity"),
        sourceSha,
        artifactFile: {
          artifactUrl: `${repoUrl}/actions/artifacts/10`,
          filename: "deployment-sha.txt",
          content: `${sourceSha}\n`,
        },
      },
      downstream: ["deployment/catalog-admin", "verification/e2e"].map((context, index) => {
        const receipt = {
          schemaVersion: 1,
          event: "workflow_run",
          context,
          sourceSha,
          deploymentRunId: 10,
          runId: 11 + index,
          runAttempt: 1,
          targetUrl: "https://production.example.test",
          expectedUrl: "https://production.example.test",
          recordedAt: new Date().toISOString(),
        };
        return {
          run: run(
            11 + index,
            index === 0
              ? ".github/workflows/deploy-catalog-admin.yml"
              : ".github/workflows/e2e.yml",
          ),
          artifact: artifact(11 + index, "post-deploy-receipt"),
          receipt,
          artifactFile: {
            artifactUrl: `${repoUrl}/actions/artifacts/${11 + index}`,
            filename: "post-deploy-receipt.json",
            content: JSON.stringify(receipt),
          },
        };
      }),
    };
    for (const change of [
      (value: typeof deployed) => {
        value.deployment.artifactFile.content = "c".repeat(40);
      },
      (value: typeof deployed) => {
        value.downstream[0].receipt.sourceSha = "c".repeat(40);
      },
    ]) {
      const changed = structuredClone(deployed);
      change(changed);
      await assert.rejects(
        handoff("observe", { snapshot: changed }),
        /artifact_contents_mismatch/u,
      );
    }
    for (const change of [
      (value: typeof deployed) => {
        value.deployment.artifactFile.artifactUrl = `${repoUrl}/actions/artifacts/999`;
      },
      (value: typeof deployed) => {
        value.downstream[0].artifactFile.filename = "wrong.json";
      },
    ]) {
      const changed = structuredClone(deployed);
      change(changed);
      await assert.rejects(handoff("observe", { snapshot: changed }), /artifact_contents_missing/u);
    }
    await assert.rejects(
      handoff("observe", {
        snapshot: { ...deployed, deployment: { ...deployed.deployment, artifactFile: undefined } },
      }),
      /artifact_contents_missing/u,
    );
    const old = structuredClone(deployed);
    old.deployment.sourceSha = "c".repeat(40);
    old.deployment.artifactFile.content = `${old.deployment.sourceSha}\n`;
    assert.equal((await handoff("observe", { snapshot: old })).phase, "delivery");
    assert.equal((await handoff("observe", { snapshot: deployed })).phase, "completed");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("handoff cannot invent a Codex review or bypass optional review wait", async () => {
  const f = await verified("optional");
  const handoff = (action: LoopHandoff, input: Record<string, unknown>) =>
    importLoopHandoff(f.state, f.workspaces, action, handoffInput(input));
  try {
    await handoff("publish", { snapshot: snapshot(f) });
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
      handoff("review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt,
      }),
      /wait_not_expired/u,
    );
    await assert.rejects(
      handoff("review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt: { ...receipt, method: "codex" },
      }),
      /codex_review_missing/u,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Math.ceil(Date.now() / 1000) * 1000 + 1000);
    receipt.completedAt = new Date().toISOString().replace(".000Z", "Z");
    const codexReview = {
      id: 3,
      pull_request_url: pullUrl,
      user: { login: "chatgpt-codex-connector[bot]" },
      commit_id: f.owner.headSha,
      state: "COMMENTED",
      submitted_at: receipt.completedAt,
    };
    await assert.rejects(
      handoff("review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt: { ...receipt, method: "codex" },
        codexReview: { ...codexReview, pull_request_url: `${pullUrl}0` },
      }),
      /codex_review_missing/u,
    );
    await assert.rejects(
      handoff("review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt: { ...receipt, method: "codex" },
        codexReview,
      }),
      /codex_review_missing/u,
    );
    assert.equal(
      (
        await handoff("review", {
          ...reviewSource,
          reviewSubmissionPages: [reviewPage([codexReview])],
          snapshot: snapshot(f),
          receipt: { ...receipt, method: "codex" },
          codexReview,
        })
      ).phase,
      "delivery",
    );
    await writeFile(join(f.workspace, "src/value.ts"), "export const value = 3;\n");
    await assert.rejects(
      handoff("review", {
        ...reviewSource,
        snapshot: snapshot(f),
        receipt: { ...receipt, method: "codex" },
        codexReview,
      }),
      /checkout_changed/u,
    );
  } finally {
    vi.useRealTimers();
    await rm(f.root, { recursive: true, force: true });
  }
});
