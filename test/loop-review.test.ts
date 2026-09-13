import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessLoopRun,
  beginLoopAttempt,
  finishLoopAttempt,
  recordLoopEvent,
} from "../scripts/harness/loop/controller.js";
import { createLoopRun, readLoopRun } from "../scripts/harness/loop/state.js";
import type { LoopSpec } from "../scripts/harness/loop/contract.js";
import {
  loopCheckout,
  loopReport,
  loopScope,
  loopSha,
  loopSpec,
  loopTime,
} from "./helpers/loop.js";

async function ready(delivery: LoopSpec["delivery"]) {
  const dir = await mkdtemp(join(tmpdir(), "loop-review-")),
    state = join(dir, "run.json");
  const spec = loopSpec();
  spec.delivery = delivery;
  await createLoopRun(spec, state, loopTime());
  await beginLoopAttempt(
    state,
    "Verified repair",
    { externalCalls: 0, reservedCostMicros: 0 },
    loopTime(1),
  );
  await finishLoopAttempt(state, loopReport(), loopCheckout, loopTime(2), {
    ...loopScope,
    changes: [{ path: "src/value.ts", status: "M", oldMode: "100644", newMode: "100644" }],
  });
  const event = async (
    type: Parameters<typeof recordLoopEvent>[2],
    data: Record<string, unknown>,
    second: number,
  ) => recordLoopEvent(state, await readLoopRun(state), type, data, loopTime(second));
  await event("review-requested", { prNumber: 1, sourceSha: loopSha }, 3);
  return { dir, state, event };
}
const receipt = (method: "self" | "codex", second: number) => ({
  method,
  completedAt: loopTime(second),
  sourceSha: loopSha,
  summary: "Checked the actual diff and regression evidence",
  reviewedPaths: ["src/value.ts"],
  unresolvedFindings: 0,
  artifactUri: ".generated/review.json",
});
function snapshot(second: number, merged = false, mainCi = false, decision: string | null = null) {
  const mergeSha = "b".repeat(40);
  const pull = {
    number: 1,
    merged,
    merge_commit_sha: merged ? mergeSha : null,
    head: { sha: loopSha },
    base: { ref: "main", sha: "c".repeat(40) },
  };
  return {
    repository: loopSpec().repository,
    collectedAt: loopTime(second),
    pull,
    pullAfter: pull,
    reviewPages: [
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: loopSha,
              reviewDecision: decision,
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
            },
          },
        },
      },
    ],
    ciRuns: [
      {
        id: mainCi ? 2 : 1,
        head_sha: mainCi ? mergeSha : loopSha,
        head_branch: "main",
        event: mainCi ? "push" : "pull_request",
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

test("optional Codex waiting expires once at 15 minutes and requires actual self-review coverage", async () => {
  const f = await ready({ target: "pr", review: "optional", reviewWaitMs: 900_000 });
  try {
    await assert.rejects(
      f.event("review-requested", { prNumber: 1, sourceSha: loopSha }, 4),
      /already_requested/u,
    );
    await assert.rejects(
      f.event("reviewed", { receipt: receipt("self", 902) }, 902),
      /wait_not_expired/u,
    );
    assert.equal(
      assessLoopRun(await readLoopRun(f.state), loopTime(903)).nextAction,
      "complete-self-review",
    );
    await assert.rejects(
      f.event("reviewed", { receipt: { ...receipt("self", 903), reviewedPaths: [] } }, 903),
      /cover_changed_paths/u,
    );
    await assert.rejects(
      f.event("reviewed", { receipt: { ...receipt("self", 903), unresolvedFindings: 1 } }, 903),
      /unresolved_review/u,
    );
    const reviewed = await f.event("reviewed", { receipt: receipt("self", 903) }, 903);
    assert.equal(reviewed.phase, "delivery");
    const stale = snapshot(904);
    stale.pull.head.sha = "d".repeat(40);
    await assert.rejects(
      f.event("delivery-observed", { snapshot: stale }, 904),
      /identity_mismatch/u,
    );
    assert.equal(
      (await f.event("delivery-observed", { snapshot: snapshot(904) }, 904)).phase,
      "completed",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("required approval cannot be waived by a timeout or a Codex comment review", async () => {
  const f = await ready({ target: "pr", review: "required", reviewWaitMs: 900_000 });
  try {
    await assert.rejects(
      f.event("reviewed", { receipt: receipt("self", 903) }, 903),
      /cannot_fall_back/u,
    );
    await f.event("reviewed", { receipt: receipt("codex", 4) }, 4);
    assert.equal(
      (await f.event("delivery-observed", { snapshot: snapshot(5) }, 5)).phase,
      "delivery",
    );
    assert.equal(
      (await f.event("delivery-observed", { snapshot: snapshot(6, false, false, "APPROVED") }, 6))
        .phase,
      "completed",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("merge completion needs main CI for the merge SHA and late completion cannot exceed the budget", async () => {
  const f = await ready({ target: "merge", review: "self", reviewWaitMs: 900_000 });
  try {
    await f.event("reviewed", { receipt: receipt("self", 4) }, 4);
    const first = await f.event("delivery-observed", { snapshot: snapshot(5) }, 5);
    assert.equal(first.phase, "delivery");
    const unchanged = await f.event("delivery-observed", { snapshot: snapshot(6) }, 6);
    assert.equal(unchanged.lastProgressAt, first.lastProgressAt);
    assert.equal(
      (await f.event("delivery-observed", { snapshot: snapshot(7, true) }, 7)).phase,
      "delivery",
    );
    await assert.rejects(
      f.event("delivery-observed", { snapshot: snapshot(1800, true, true) }, 1800),
      /budget_exhausted/u,
    );
    const complete = await f.event("delivery-observed", { snapshot: snapshot(8, true, true) }, 8);
    assert.equal(complete.phase, "completed");
    assert.equal(complete.lastVerifiedSha, loopSha);
    assert.equal(complete.lastDeliveryReport?.sourceSha, "b".repeat(40));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
