import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { dueMaintenanceTasks, isDailyMaintenanceSlot } from "../src/scheduled.js";
import { captureDatabase } from "./helpers/d1.js";

const TICK_MS = 5 * 60 * 1000;

/** The general cron's tick sequence, starting from an arbitrary aligned wall-clock time. */
function ticks(count: number): Date[] {
  const start = Date.parse("2026-08-28T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => new Date(start + index * TICK_MS));
}

test("a tick starts only the maintenance that is actually due", () => {
  // The whole point of the rotation: one tick must not be the moment every background task talks
  // to D1 at once. Projection repair is intentionally due every tick; ten-minute work is offset so
  // the hourly bootstrap can still fit without exceeding four sequential tasks.
  const perTick = ticks(12).map((at) => dueMaintenanceTasks(at).length);

  assert.ok(
    Math.max(...perTick) <= 4,
    `no tick should start more than four sequential tasks, saw ${JSON.stringify(perTick)}`,
  );
});

test("projection repair runs on every general-cron tick", () => {
  for (const at of ticks(12)) {
    assert.ok(
      dueMaintenanceTasks(at).some((task) => task.name === "product_search_projection_repair"),
      `${at.toISOString()} should run product search projection repair`,
    );
  }
});

test("every sub-daily maintenance task still runs within an hour", () => {
  const seen = new Set(ticks(12).flatMap((at) => dueMaintenanceTasks(at).map((task) => task.name)));

  // Spreading the load must not silently drop ordinary work. The catalog-sized exact-identity
  // safety net is intentionally the one exception and has its own daily-cadence assertion below.
  assert.deepEqual(
    [...seen].sort(),
    [
      "data_quality_remediation_sweep",
      "knowledge_catalog_queue_quota_recovery",
      "knowledge_catalog_review_bootstrap",
      "price_index_recent_refresh",
      "product_search_projection_repair",
      "resume_interrupted_crawl_runs",
      "stale_knowledge_catalog_export_jobs",
      "stale_product_audit_export_jobs",
    ],
    "an hour of ticks should cover every sub-daily task exactly once or more",
  );
});

test("recent price-index maintenance runs once per hour", () => {
  const firesIn = ticks(12).filter((at) =>
    dueMaintenanceTasks(at).some((task) => task.name === "price_index_recent_refresh"),
  );

  assert.equal(firesIn.length, 1, "the ninety-day expiry projection only needs hourly precision");
});

test("the scheduled price-index task invokes bounded backfill and expiry maintenance", async () => {
  const at = ticks(12).find((tick) =>
    dueMaintenanceTasks(tick).some((task) => task.name === "price_index_recent_refresh"),
  );
  assert.ok(at);
  const task = dueMaintenanceTasks(at).find(
    (candidate) => candidate.name === "price_index_recent_refresh",
  );
  assert.ok(task);
  const db = captureDatabase((statement) => {
    if (/FROM knowledge_catalog_price_index_recent_backfill_runs/u.test(statement.sql)) {
      return [{ after_catalog_product_id: 100, status: "completed" }];
    }
    return [];
  });
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    await task.run({ DB: db } as unknown as Env);
  } finally {
    console.log = originalLog;
  }

  assert.equal(db.calls.length, 2, "completed backfill plus an empty due selector stay bounded");
  assert.equal(
    db.calls.some((statement) => /knowledge_catalog_price_index_samples/u.test(statement.sql)),
    false,
  );
  assert.deepEqual(JSON.parse(lines.at(-1) || "{}"), {
    event: "price_index_recent_refresh",
    backfillStatus: "completed",
    backfillSelectedProducts: 0,
    backfilledProducts: 0,
    backfillHasMore: false,
    dueProducts: 0,
    refreshedProducts: 0,
    refreshHasMore: false,
  });
});

test("the exact-identity full-scan safety net runs once per day", () => {
  const fullScans = ticks(288).filter((at) =>
    dueMaintenanceTasks(at).some((task) => task.name === "product_search_exact_identity_repair"),
  );

  assert.deepEqual(
    fullScans.map((at) => at.toISOString()),
    ["2026-08-28T18:00:00.000Z"],
    "the catalog-sized self-join must not return to an hourly cadence",
  );
  assert.equal(
    fullScans.some(isDailyMaintenanceSlot),
    false,
    "the safety scan should not stack on the heavier daily-maintenance slot",
  );
});

test("the daily slot keeps the concurrency it had before the hourly task was added", () => {
  // The runner appends daily_maintenance to whatever is already due, so a task inserted into the
  // table can quietly make the heaviest slot of the day heavier still. Offsets are stated per task
  // rather than taken from array position precisely so that adding one cannot do that.
  const dailySlot = ticks(288).find((at) => isDailyMaintenanceSlot(at));
  assert.ok(dailySlot, "the day should contain the daily maintenance slot");

  const concurrent = dueMaintenanceTasks(dailySlot).length + 1;

  assert.equal(concurrent, 4, "three regular tasks plus daily maintenance, as before");
});

test("tasks sharing a cadence are offset onto different ticks", () => {
  // Five tasks run every other tick. Left unoffset they would all land together and rebuild the
  // burst this replaced, so their table offsets have to split them across alternating ticks.
  const tenMinutely = new Set([
    "resume_interrupted_crawl_runs",
    "data_quality_remediation_sweep",
    "stale_product_audit_export_jobs",
    "stale_knowledge_catalog_export_jobs",
    "knowledge_catalog_queue_quota_recovery",
  ]);

  for (const at of ticks(12)) {
    const due = dueMaintenanceTasks(at).filter((task) => tenMinutely.has(task.name));
    assert.ok(
      due.length === 2 || due.length === 3,
      `${at.toISOString()} started ${due.length} ten-minute tasks`,
    );
  }
});

test("quota recovery probes every ten minutes without raising the per-tick cap", () => {
  const firesIn = ticks(4).filter((at) =>
    dueMaintenanceTasks(at).some((task) => task.name === "knowledge_catalog_queue_quota_recovery"),
  );
  assert.equal(firesIn.length, 2, "queue quota recovery should run every ten minutes");
});

test("export recovery stays close to the two-minute threshold it exists to enforce", () => {
  // Both export services treat a job as stuck after 120s. Spreading maintenance load must not
  // quietly turn that into an hour of a user-visible export sitting stuck.
  for (const name of ["stale_product_audit_export_jobs", "stale_knowledge_catalog_export_jobs"]) {
    const firesIn = ticks(4).filter((at) =>
      dueMaintenanceTasks(at).some((task) => task.name === name),
    );
    assert.equal(firesIn.length, 2, `${name} should still run every ten minutes`);
  }
});

test("the rotation follows the wall clock, so an isolate restart cannot reset it", () => {
  // Position in the cycle is derived from the scheduled time rather than a counter. Two runs of the
  // same tick therefore agree, which is what makes the cadence hold across deploys and cold starts.
  const at = new Date("2026-08-28T00:35:00.000Z");
  const names = () => dueMaintenanceTasks(at).map((task) => task.name);

  assert.deepEqual(names(), names());
});
