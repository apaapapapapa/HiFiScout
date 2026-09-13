import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDelivery } from "../scripts/harness/github.js";
import { assessDelivery } from "../scripts/harness/delivery.js";
import type { DeliverySnapshot } from "../scripts/harness/delivery.js";
import { parsePostDeployReceipt } from "../scripts/harness/post-deploy.js";

const sourceSha = "a".repeat(40);
test("collector follows the status run, downloads its identity and preserves the raw snapshot", async () => {
  const s = snapshot();
  const dir = await mkdtemp(join(tmpdir(), "harness-collector-test-"));
  const calls: string[][] = [];
  const invoke = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "run" && args[1] === "download") {
      const downstream = s.downstream.find(
        (item) => String((item.run as { id: number }).id) === args[2],
      );
      await writeFile(
        join(
          args[args.indexOf("--dir") + 1],
          downstream ? "post-deploy-receipt.json" : "deployment-sha.txt",
        ),
        downstream ? JSON.stringify(downstream.receipt) : sourceSha + "\n",
      );
      return "";
    }
    assert.equal(args[0], "api");
    if (args.includes("graphql")) return JSON.stringify(s.reviewPages);
    assert.equal(args[args.indexOf("--method") + 1], "GET");
    const path = args.at(-1)!;
    if (path.endsWith("/pulls/1")) return JSON.stringify(s.pull);
    if (path.includes("/commits/")) {
      assert.ok(path.includes(sourceSha));
      return JSON.stringify([s.statuses.slice(0, 1), s.statuses.slice(1)]);
    }
    if (path.includes("/workflows/ci.yml/")) return JSON.stringify([{ workflow_runs: s.ciRuns }]);
    if (path.endsWith("/actions/runs/10")) return JSON.stringify(s.deployment!.run);
    for (const item of s.downstream) {
      const id = (item.run as { id: number }).id;
      if (path.endsWith(`/actions/runs/${id}`)) return JSON.stringify(item.run);
      if (path.includes(`/actions/runs/${id}/artifacts?`))
        return JSON.stringify([{ artifacts: [item.artifact] }]);
    }
    if (path.includes("/artifacts?"))
      return JSON.stringify([{ artifacts: [s.deployment!.artifact] }]);
    throw new Error("unexpected_github_request");
  };
  try {
    assert.equal((await collectDelivery("owner/repo", 1, dir, invoke)).status, "pass");
    assert.equal(calls.filter((c) => c.at(-1)?.endsWith("/pulls/1")).length, 2);
    assert.equal(
      JSON.parse(await readFile(join(dir, "github-snapshot.json"), "utf8")).deployment.sourceSha,
      sourceSha,
    );
    await assert.rejects(
      collectDelivery("owner/repo", 1, dir, async () => {
        throw new Error("authentication_failed");
      }),
      /authentication_failed/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
function snapshot(): DeliverySnapshot {
  const pull = {
    number: 1,
    merged: true,
    merge_commit_sha: sourceSha,
    head: { sha: "b".repeat(40) },
    base: { ref: "main", sha: "c".repeat(40) },
  };
  return {
    repository: "owner/repo",
    collectedAt: "2026-09-13T00:00:00Z",
    pull,
    pullAfter: pull,
    reviewPages: [
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: pull.head.sha,
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
        head_sha: sourceSha,
        path: ".github/workflows/ci.yml",
        event: "push",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
      },
    ],
    statuses: ["deployment/cloudflare", "deployment/catalog-admin", "verification/e2e"].map(
      (context, id) => ({
        id,
        context,
        state: "success",
        description: "Verified",
        target_url: `https://github.com/owner/repo/actions/runs/${10 + id}`,
      }),
    ),
    deployment: {
      run: {
        id: 10,
        path: ".github/workflows/deploy.yml",
        status: "completed",
        conclusion: "success",
      },
      artifact: { name: "deployment-identity", expired: false, workflow_run: { id: 10 } },
      sourceSha,
    },
    downstream: ["deployment/catalog-admin", "verification/e2e"].map((context, index) => ({
      run: {
        id: 11 + index,
        path:
          index === 0 ? ".github/workflows/deploy-catalog-admin.yml" : ".github/workflows/e2e.yml",
        event: "workflow_run",
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
      },
      artifact: { name: "post-deploy-receipt", expired: false, workflow_run: { id: 11 + index } },
      receipt: {
        schemaVersion: 1,
        event: "workflow_run",
        context,
        sourceSha,
        deploymentRunId: 10,
        runId: 11 + index,
        runAttempt: 1,
        targetUrl: "https://production.example.test",
        expectedUrl: "https://production.example.test",
        recordedAt: "2026-09-13T00:00:00Z",
      },
    })),
  };
}

test("manual staging success, unrelated parents and receipts from an older attempt do not prove production verification", () => {
  for (const patch of [
    { event: "workflow_dispatch" },
    { run_attempt: 2 },
    { path: ".github/workflows/unrelated.yml" },
  ]) {
    const s = snapshot();
    s.downstream[1].run = { ...(s.downstream[1].run as object), ...patch };
    assert.equal(assessDelivery(s).status, "unknown");
  }
  const s = snapshot();
  const receipt = s.downstream[1].receipt as Record<string, unknown>;
  s.downstream[1].receipt = { ...receipt, deploymentRunId: 999 };
  assert.equal(assessDelivery(s).status, "unknown");
  assert.throws(
    () => parsePostDeployReceipt({ ...receipt, targetUrl: "https://staging.example.test" }),
    /non_production/u,
  );
  assert.throws(
    () => parsePostDeployReceipt({ ...receipt, event: "workflow_dispatch" }),
    /invalid_post/u,
  );
});

test("delivery uses artifact contents and the latest CI, keeping effectiveness separate", () => {
  const s = snapshot();
  const result = assessDelivery(s);
  assert.equal(result.status, "pass");
  assert.equal(result.checks.find((c) => c.id === "production-effectiveness")?.status, "unknown");
  assert.equal(result.checks.find((c) => c.id === "paused-operational-health")?.status, "skipped");
  s.deployment!.sourceSha = "d".repeat(40);
  assert.equal(assessDelivery(s).status, "unknown");
  s.deployment = snapshot().deployment;
  s.ciRuns.push({ ...(s.ciRuns[0] as object), id: 2, conclusion: "failure" });
  assert.equal(assessDelivery(s).status, "fail");
});

test("green deferred/no-op deployment and successful unrelated CI cannot establish delivery", () => {
  for (const description of [
    "Cloudflare deployment deferred by D1 quota",
    "Cloudflare application unchanged",
    "Cloudflare deployment already current",
  ]) {
    const s = snapshot();
    s.statuses[0] = { ...(s.statuses[0] as object), description };
    s.deployment = null;
    assert.equal(assessDelivery(s).status, "unknown");
  }
  const s = snapshot();
  s.ciRuns = [{ ...(s.ciRuns[0] as object), head_sha: "e".repeat(40) }];
  assert.equal(assessDelivery(s).status, "unknown");
  s.ciRuns = snapshot().ciRuns;
  s.deployment!.artifact = {
    name: "deployment-identity",
    expired: false,
    workflow_run: { id: 999 },
  };
  assert.equal(assessDelivery(s).status, "unknown");
});

test("unresolved, truncated, stale reviews and a moving PR prevent completion", () => {
  for (const patch of [
    { reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } } },
    { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } },
    { headRefOid: "f".repeat(40) },
    { reviewDecision: "REVIEW_REQUIRED" },
  ]) {
    const s = snapshot();
    s.reviewPages = [
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: "b".repeat(40),
              reviewDecision: null,
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
              ...patch,
            },
          },
        },
      },
    ];
    assert.equal(assessDelivery(s).status, "unknown");
  }
  const s = snapshot();
  s.pullAfter = { ...(s.pullAfter as object), head: { sha: "f".repeat(40) } };
  assert.equal(assessDelivery(s).status, "unknown");
});
