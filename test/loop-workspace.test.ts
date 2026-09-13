import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyLoopPatch,
  loopGit,
  prepareLoopWorkspace,
} from "../scripts/harness/loop/workspace.js";
import { beginLoopAttempt, assessLoopRun } from "../scripts/harness/loop/controller.js";
import { readLoopRun } from "../scripts/harness/loop/state.js";
import { loopGitFixture as fixture } from "./helpers/loop-git.js";

const patch = (path: string, before: string, after: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;

test("isolated patch application is source-bound, idempotent and leaves the original checkout intact", async () => {
  const f = await fixture();
  try {
    const prepared = await prepareLoopWorkspace(f.state, f.source, f.workspaces);
    assert.equal(
      (await prepareLoopWorkspace(f.state, f.source, f.workspaces)).workspace,
      prepared.workspace,
    );
    const change = patch("src/value.ts", "export const value = 1;", "export const value = 2;");
    await assert.rejects(
      applyLoopPatch(f.state, f.workspaces, 1, f.sha, change),
      /no_matching_active/u,
    );
    await beginLoopAttempt(f.state, "Reproduce and fix the value", {
      externalCalls: 0,
      reservedCostMicros: 0,
    });
    const applied = await applyLoopPatch(f.state, f.workspaces, 1, f.sha, change);
    assert.notEqual(applied.checkout.sourceSha, f.sha);
    assert.equal(applied.checkout.dirty, false);
    assert.equal(
      await readFile(join(f.source, "src/value.ts"), "utf8"),
      "export const value = 1;\n",
    );
    assert.equal(
      (await applyLoopPatch(f.state, f.workspaces, 1, f.sha, change)).owner.headSha,
      applied.owner.headSha,
    );
    await assert.rejects(
      applyLoopPatch(f.state, f.workspaces, 1, f.sha, change + "\n"),
      /another_patch/u,
    );
    // Simulate termination after saving the pending transaction but before moving the worktree.
    await writeFile(
      `${prepared.workspace}.json`,
      JSON.stringify({
        ...applied.owner,
        pending: { baseSha: f.sha, candidateSha: applied.owner.headSha },
      }),
    );
    loopGit(prepared.workspace, ["reset", "--hard", f.sha]);
    assert.equal(
      (await applyLoopPatch(f.state, f.workspaces, 1, f.sha, change)).owner.headSha,
      applied.owner.headSha,
    );
    await writeFile(join(prepared.workspace, "src/value.ts"), "unrelated edits\n");
    await assert.rejects(
      prepareLoopWorkspace(f.state, f.source, f.workspaces),
      /checkout_changed/u,
    );
    assert.equal(
      await readFile(join(prepared.workspace, "src/value.ts"), "utf8"),
      "unrelated edits\n",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("protected patches block the run before worktree changes and keep charged attempts", async () => {
  const f = await fixture();
  try {
    const prepared = await prepareLoopWorkspace(f.state, f.source, f.workspaces);
    await beginLoopAttempt(f.state, "Attempt outside scope", {
      externalCalls: 1,
      reservedCostMicros: 0,
    });
    await assert.rejects(
      applyLoopPatch(f.state, f.workspaces, 1, f.sha, patch(".gitignore", ".generated/", "")),
      /patch_rejected/u,
    );
    assert.equal(loopGit(prepared.workspace, ["rev-parse", "HEAD"]), f.sha);
    const view = assessLoopRun(await readLoopRun(f.state));
    assert.equal(view.phase, "blocked");
    assert.equal(view.externalCalls, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
