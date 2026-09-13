import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  compareCosts,
  costReport,
  readCostSamples,
  REQUIRED_COST_SAMPLES,
  parseCostSample,
} from "../scripts/harness/cost.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repositoryArtifact } from "../scripts/harness/artifacts.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { asQueryableDatabase } from "./helpers/d1.js";

test("cost reports persist unknown checks for missing samples and reference real sample paths", async () => {
  await mkdir(".generated", { recursive: true });
  const directory = await mkdtemp(".generated/harness-cost-paths-");
  try {
    const samples = join(directory, "samples"),
      output = join(directory, "reports", "cost.json");
    const empty = await costReport(samples, output);
    assert.equal(empty.status, "unknown");
    assert.equal(empty.checks.length, REQUIRED_COST_SAMPLES.length);
    assert.ok(empty.checks.every((check) => check.status === "unknown"));
    assert.equal(JSON.parse(await readFile(output, "utf8")).status, "unknown");
    await mkdir(samples);
    await assert.rejects(readCostSamples(samples), /missing_or_duplicate/u);
    const sample = {
      schemaVersion: 1,
      kind: "cost-sample",
      id: "category-prune",
      sourceSha: "a".repeat(40),
      checkoutClean: true,
      recordedAt: "2026-09-13T00:00:00Z",
      profileHash: "b".repeat(64),
      environment: "local-workerd",
      metrics: { rowsRead: 1, rowsWritten: 0, sqlStatements: 1 },
      notes: [],
      queryPlans: [],
    };
    await writeFile(join(samples, "category-prune.json"), JSON.stringify(sample));
    const report = await costReport(samples, output);
    const uri = report.checks.find((check) => check.id === "cost/category-prune")!.evidence[0].uri;
    assert.equal(JSON.parse(await readFile(uri, "utf8")).id, "category-prune");
    assert.equal(repositoryArtifact(resolve(uri)), uri);
    assert.throws(() => repositoryArtifact("../outside.json"), /repository_relative/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
