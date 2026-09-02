import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { dueMaintenanceTasks } from "../src/scheduled.js";

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

test("every maintenance task still runs within an hour", () => {
  const seen = new Set(ticks(12).flatMap((at) => dueMaintenanceTasks(at).map((task) => task.name)));

  // Spreading the load must not silently drop work. Twelve ticks is one hour, the longest cadence.
  assert.deepEqual(
    [...seen].sort(),
    [
      "data_quality_remediation_sweep",
      "knowledge_catalog_queue_quota_recovery",
      "knowledge_catalog_review_bootstrap",
      "product_search_exact_identity_repair",
      "product_search_projection_repair",
      "resume_interrupted_crawl_runs",
      "stale_knowledge_catalog_export_jobs",
      "stale_product_audit_export_jobs",
    ],
    "an hour of ticks should cover every task exactly once or more",
  );
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
