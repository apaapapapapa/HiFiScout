import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  beginLoopAttempt,
  finishLoopAttempt,
  recordLoopEvent,
} from "../scripts/harness/loop/controller.js";
import { createLoopRun, readLoopRun } from "../scripts/harness/loop/state.js";
import { loopStatus } from "../scripts/harness/loop/status.js";
import { loopCheckout, loopReport, loopScope, loopSpec, loopTime } from "./helpers/loop.js";

test("status distinguishes heartbeat, evaluation improvement, remaining reservations and the fixed deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-status-")),
    path = join(root, "state.json");
  try {
    await createLoopRun(loopSpec(), path, loopTime());
    await beginLoopAttempt(
      path,
      "Reproduce",
      { externalCalls: 1, reservedCostMicros: 0 },
      loopTime(1),
    );
    await finishLoopAttempt(path, loopReport("fail", 2), loopCheckout, loopTime(2), loopScope);
    await recordLoopEvent(path, await readLoopRun(path), "heartbeat", {}, loopTime(3));
    const failed = loopStatus(await readLoopRun(path), loopTime(4));
    assert.equal(failed.lastHeartbeatAt, loopTime(3));
    assert.equal(failed.lastImprovementAt, null);
    assert.equal(failed.lastProgressAt, loopTime(2));
    assert.equal(failed.remaining.externalCalls, 2);
    assert.equal(failed.blockers[0].id, "source-checks");
    assert.equal(failed.estimatedCompletionAt, null);
    assert.equal(failed.processLiveness, "not_observed");
    await beginLoopAttempt(
      path,
      "Repair",
      { externalCalls: 1, reservedCostMicros: 0 },
      loopTime(5),
    );
    await finishLoopAttempt(path, loopReport("pass", 6), loopCheckout, loopTime(6), loopScope);
    const passed = loopStatus(await readLoopRun(path), loopTime(7));
    assert.equal(passed.lastImprovementAt, loopTime(6));
    assert.equal(passed.deadline, failed.deadline);
    const expired = loopStatus(await readLoopRun(path), loopTime(1800));
    assert.equal(expired.phase, "stopped");
    assert.equal(expired.nextCheckAt, null);
    assert.equal(expired.remaining.durationMs, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
