import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessLoopRun,
  beginLoopAttempt,
  finishLoopAttempt,
  recordLoopEvent,
} from "../scripts/harness/loop/controller.js";
import { createLoopRun, readLoopRun } from "../scripts/harness/loop/state.js";
import { loopCheckout, loopReport, loopSpec, loopTime } from "./helpers/loop.js";
const free = { externalCalls: 0, reservedCostMicros: 0 };

test("a passing source attempt advances to review; missing, stale or skipped evidence blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-controller-"));
  try {
    for (const status of ["pass", "unknown", "skipped", "missing", "stale"] as const) {
      const path = join(dir, `${status}.json`);
      await createLoopRun(loopSpec(), path, loopTime());
      await beginLoopAttempt(path, "Repair the reproducible defect", free, loopTime(1));
      const report = loopReport(status === "missing" || status === "stale" ? "pass" : status);
      if (status === "missing") report.checks[0].id = "not-the-required-check";
      const result = await finishLoopAttempt(
        path,
        report,
        { ...loopCheckout, dirty: status === "stale" },
        loopTime(3),
      );
      assert.equal(result.phase, status === "pass" ? "review" : "blocked");
      assert.notEqual(result.phase, "completed");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed attempts stop at no-progress/iteration limits and cannot restart through a heartbeat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-no-progress-"));
  const path = join(dir, "state.json");
  try {
    const spec = loopSpec();
    spec.budget.maxIterations = 10;
    await createLoopRun(spec, path, loopTime());
    for (let n = 0; n < 3; n++) {
      await beginLoopAttempt(path, "Try a bounded repair", free, loopTime(n * 3 + 1));
      await finishLoopAttempt(
        path,
        loopReport("fail", n * 3 + 2),
        loopCheckout,
        loopTime(n * 3 + 2),
      );
    }
    assert.equal(assessLoopRun(await readLoopRun(path), loopTime(10)).reason, "no_progress_limit");
    await assert.rejects(
      beginLoopAttempt(path, "try again", free, loopTime(11)),
      /no_progress_limit/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reservations are charged before work and remain charged after interruption/resume", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-reservation-"));
  const path = join(dir, "state.json");
  try {
    const spec = loopSpec();
    spec.budget.maxReservedCostMicros = 100;
    spec.budget.maxExternalCalls = 1;
    await createLoopRun(spec, path, loopTime());
    await assert.rejects(
      beginLoopAttempt(
        path,
        "too expensive",
        { externalCalls: 1, reservedCostMicros: 101 },
        loopTime(1),
      ),
      /reservation_exceeds_budget/u,
    );
    assert.equal((await readLoopRun(path)).revision, 1);
    await beginLoopAttempt(
      path,
      "reserved",
      { externalCalls: 1, reservedCostMicros: 100 },
      loopTime(1),
    );
    await recordLoopEvent(
      path,
      await readLoopRun(path),
      "blocked",
      { reason: "runner_interrupted" },
      loopTime(2),
    );
    const resumed = await recordLoopEvent(
      path,
      await readLoopRun(path),
      "resumed",
      { reason: "runner is stopped" },
      loopTime(3),
    );
    assert.equal(resumed.externalCalls, 1);
    assert.equal(resumed.reservedCostMicros, 100);
    assert.equal(resumed.attempts, 1);
    await assert.rejects(
      beginLoopAttempt(
        path,
        "charge twice",
        { externalCalls: 1, reservedCostMicros: 1 },
        loopTime(4),
      ),
      /reservation_exceeds_budget/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("heartbeats do not move progress or extend a fixed deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loop-deadline-"));
  const path = join(dir, "state.json");
  try {
    const spec = loopSpec();
    spec.budget.maxDurationMs = 5000;
    await createLoopRun(spec, path, loopTime());
    const view = await recordLoopEvent(path, await readLoopRun(path), "heartbeat", {}, loopTime(4));
    assert.equal(view.lastProgressAt, loopTime());
    assert.equal(
      assessLoopRun(await readLoopRun(path), loopTime(5)).reason,
      "time_budget_exhausted",
    );
    await assert.rejects(
      beginLoopAttempt(path, "late", free, loopTime(6)),
      /time_budget_exhausted/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
