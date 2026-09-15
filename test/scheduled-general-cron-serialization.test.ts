import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { runGeneralCronTick } from "../src/scheduled.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("GENERAL_CRON watchdogs start only after maintenance settles", async () => {
  const maintenance = deferred<void>();
  const events: string[] = [];

  const tick = runGeneralCronTick(
    async () => {
      events.push("maintenance:start");
      await maintenance.promise;
      events.push("maintenance:end");
    },
    async () => {
      events.push("watchdog");
      return "done";
    },
  );

  await Promise.resolve();
  assert.deepEqual(events, ["maintenance:start"]);

  maintenance.resolve();
  assert.equal(await tick, "done");
  assert.deepEqual(events, ["maintenance:start", "maintenance:end", "watchdog"]);
});

test("GENERAL_CRON still runs maintenance before rethrowing a scheduled failure", async () => {
  const scheduledError = new Error("watchdog failed");
  const maintenance = deferred<void>();
  const events: string[] = [];

  const tick = runGeneralCronTick(
    async () => {
      events.push("maintenance:start");
      await maintenance.promise;
      events.push("maintenance:end");
    },
    async () => {
      events.push("scheduled");
      throw scheduledError;
    },
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["maintenance:start"]);

  maintenance.resolve();
  await assert.rejects(tick, (error: unknown) => error === scheduledError);
  assert.deepEqual(events, ["maintenance:start", "maintenance:end", "scheduled"]);
});

test("GENERAL_CRON admits maintenance before the cross-shop health snapshot", async () => {
  const events: string[] = [];
  const result = await runGeneralCronTick(
    async () => {
      events.push("maintenance");
    },
    async () => {
      events.push("watchdog");
      return "dispatch";
    },
    async (dispatch) => {
      assert.equal(dispatch, "dispatch");
      events.push("health");
    },
  );

  assert.equal(result, "dispatch");
  assert.deepEqual(events, ["maintenance", "watchdog", "health"]);
});

test("GENERAL_CRON leaves health for the next tick when maintenance yields", async () => {
  let healthRuns = 0;
  await assert.rejects(
    runGeneralCronTick(
      async () => {
        throw new Error("budget yield");
      },
      async () => "dispatch",
      async () => {
        healthRuns += 1;
      },
    ),
    /budget yield/,
  );
  assert.equal(healthRuns, 0);
});
