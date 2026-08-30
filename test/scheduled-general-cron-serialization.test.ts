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

test("GENERAL_CRON maintenance starts only after scheduled work settles", async () => {
  const scheduled = deferred<string>();
  const events: string[] = [];

  const tick = runGeneralCronTick(
    async () => {
      events.push("scheduled:start");
      const value = await scheduled.promise;
      events.push("scheduled:end");
      return value;
    },
    async () => {
      events.push("maintenance:start");
    },
  );

  await Promise.resolve();
  assert.deepEqual(events, ["scheduled:start"]);

  scheduled.resolve("done");
  assert.equal(await tick, "done");
  assert.deepEqual(events, ["scheduled:start", "scheduled:end", "maintenance:start"]);
});

test("GENERAL_CRON still runs maintenance before rethrowing a scheduled failure", async () => {
  const scheduledError = new Error("watchdog failed");
  const maintenance = deferred<void>();
  const events: string[] = [];

  const tick = runGeneralCronTick(
    async () => {
      events.push("scheduled");
      throw scheduledError;
    },
    async () => {
      events.push("maintenance:start");
      await maintenance.promise;
      events.push("maintenance:end");
    },
  );

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["scheduled", "maintenance:start"]);

  maintenance.resolve();
  await assert.rejects(tick, (error: unknown) => error === scheduledError);
  assert.deepEqual(events, ["scheduled", "maintenance:start", "maintenance:end"]);
});
