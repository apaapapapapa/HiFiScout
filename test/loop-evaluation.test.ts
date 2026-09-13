import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loopGitFixture } from "./helpers/loop-git.js";
import { applyLoopPatch, prepareLoopWorkspace } from "../scripts/harness/loop/workspace.js";
import { beginLoopAttempt } from "../scripts/harness/loop/controller.js";
import { evaluateLoopAttempt } from "../scripts/harness/loop/evaluation.js";
import { runLoopCommand } from "../scripts/harness/loop/command.js";
import type { LoopCommand, LoopCommandResult } from "../scripts/harness/loop/command.js";

test("a real Git candidate moves from failure through repair to verified review without resetting attempts", async () => {
  const f = await loopGitFixture();
  try {
    await prepareLoopWorkspace(f.state, f.source, f.workspaces);
    const invoke = async (request: LoopCommand): Promise<LoopCommandResult> => {
      const startedAt = new Date().toISOString();
      const content = await readFile(join(request.cwd, "src/value.ts"), "utf8");
      const status =
        request.args[0] === "install" || content.includes("value = 2") ? "pass" : "fail";
      await mkdir(dirname(request.logPath), { recursive: true });
      await writeFile(request.logPath, `${request.args.join(" ")}: ${status}`, { flag: "wx" });
      return {
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        reason: "fixture_assertion",
      };
    };
    await beginLoopAttempt(f.state, "Reproduce the failure", {
      externalCalls: 0,
      reservedCostMicros: 0,
    });
    const failure = await evaluateLoopAttempt(f.state, f.workspaces, undefined, invoke);
    assert.equal(failure.phase, "ready");
    assert.equal(failure.lastReport?.checks.find((c) => c.id === "source-checks")?.status, "fail");
    await beginLoopAttempt(f.state, "Correct the value", {
      externalCalls: 1,
      reservedCostMicros: 0,
    });
    const change =
      "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n";
    const applied = await applyLoopPatch(f.state, f.workspaces, 2, f.sha, change);
    const success = await evaluateLoopAttempt(f.state, f.workspaces, undefined, invoke);
    assert.equal(success.phase, "review");
    assert.equal(success.lastVerifiedSha, applied.owner.headSha);
    assert.equal(success.attempts, 2);
    assert.equal(success.externalCalls, 1);
    await assert.rejects(
      evaluateLoopAttempt(f.state, f.workspaces, undefined, invoke),
      /requires_active/u,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("verification subprocesses lose provider credentials and stop at the wall-clock deadline", async () => {
  const f = await loopGitFixture();
  const previousPath = process.env.PATH,
    previousProbe = process.env.LOOP_SECRET_PROBE;
  try {
    const bin = join(f.root, "bin");
    await mkdir(bin);
    const vp = join(bin, "vp");
    await writeFile(
      vp,
      '#!/bin/sh\nif [ -n "$LOOP_SECRET_PROBE" ]; then exit 4; fi\nif [ "$1" = "wait" ]; then sleep 30; fi\necho checked\n',
    );
    await chmod(vp, 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.LOOP_SECRET_PROBE = "fixture-only";
    const result = await runLoopCommand({
      cwd: f.source,
      args: ["check"],
      logPath: join(f.root, "check.log"),
      deadline: new Date(Date.now() + 10_000).toISOString(),
    });
    assert.equal(result.status, "pass");
    assert.match(await readFile(join(f.root, "check.log"), "utf8"), /checked/u);
    const start = Date.now();
    const timeout = await runLoopCommand({
      cwd: f.source,
      args: ["wait"],
      logPath: join(f.root, "wait.log"),
      deadline: new Date(Date.now() + 100).toISOString(),
    });
    assert.equal(timeout.status, "unknown");
    assert.equal(timeout.reason, "command_deadline_exhausted");
    assert.ok(Date.now() - start < 5000);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousProbe === undefined) delete process.env.LOOP_SECRET_PROBE;
    else process.env.LOOP_SECRET_PROBE = previousProbe;
    await rm(f.root, { recursive: true, force: true });
  }
});
