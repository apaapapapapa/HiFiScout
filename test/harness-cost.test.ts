import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { compareCosts, parseCostSample } from "../scripts/harness/cost.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { asQueryableDatabase } from "./helpers/d1.js";

test("D1 cost leaves missing row metadata unknown while counting failed and batched statements once", async () => {
  const statement = {
    bind() {
      return this;
    },
    async all() {
      return { results: [], meta: { rows_read: 0, rows_written: 0 } };
    },
    async run() {
      throw new Error("failed SQL");
    },
    async first() {
      return { n: 0 };
    },
  };
  const db = asQueryableDatabase({
    prepare: () => statement,
    batch: async () => [{ results: [], meta: { rows_read: 2 } }],
  });
  const measured = measureD1Cost(db);
  assert.equal(measured.metrics().rowsRead, null);
  await measured.db.prepare("SELECT 1").all();
  assert.equal(measured.metrics().rowsRead, 0, "measured zero stays zero");
  await measured.db.batch([measured.db.prepare("SELECT 2")]);
  assert.deepEqual(measured.metrics(), { rowsRead: 2, rowsWritten: null, sqlStatements: 2 });
  await assert.rejects(measured.db.prepare("bad").run());
  assert.deepEqual(measured.metrics(), { rowsRead: null, rowsWritten: null, sqlStatements: 3 });
  const first = measureD1Cost(db);
  await first.db.prepare("SELECT 1").first();
  assert.deepEqual(first.metrics(), { rowsRead: null, rowsWritten: null, sqlStatements: 1 });
});

test("cost comparisons refuse mixed profiles and preserve unknown and zero baselines", () => {
  const sample = {
    schemaVersion: 1,
    kind: "cost-sample",
    id: "fixture",
    sourceSha: "a".repeat(40),
    checkoutClean: true,
    recordedAt: "2026-09-13T00:00:00Z",
    profileHash: "b".repeat(64),
    environment: "local-workerd",
    metrics: { rowsWritten: 0 },
    notes: [],
    queryPlans: [],
  };
  const increased = { ...sample, sourceSha: "c".repeat(40), metrics: { rowsWritten: 2 } };
  const result = compareCosts([sample], [increased]);
  assert.equal(result.status, "fail");
  assert.equal(result.rows[0].delta, 2);
  assert.equal(result.rows[0].ratio, null);
  assert.equal(result.productionCpuP95Ms, null);
  for (const incomplete of [
    { ...increased, metrics: { rowsWritten: null } },
    { ...increased, environment: "local-mock" },
    { ...increased, checkoutClean: false },
    { ...increased, profileHash: "d".repeat(64) },
  ])
    assert.equal(compareCosts([sample], [incomplete]).status, "unknown");
  assert.throws(
    () => parseCostSample({ ...sample, metrics: { rowsRead: -1 } }),
    /invalid_cost_metric/u,
  );
});
