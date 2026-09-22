import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  aggregateCpuRounds,
  comparePairedCpu,
  parseCpuCeilings,
} from "../scripts/harness/load-cpu.js";
import { compareCosts } from "../scripts/harness/cost.js";

function sample(cpuRelative: number, sourceSha = "a".repeat(40)) {
  return {
    schemaVersion: 1 as const,
    kind: "cost-sample" as const,
    id: "cpu-parse",
    sourceSha,
    checkoutClean: true,
    recordedAt: "2026-09-22T00:00:00Z",
    profileHash: "c".repeat(64),
    environment: "local-node" as const,
    metrics: { cpuUs: cpuRelative * 100, cpuRelative },
    notes: [],
    queryPlans: [],
  };
}

const ceilings = () => [1, 2, 3].map(() => ({ "cpu-parse": 50 }));

test("paired comparisons use one reference and still block slower work if the candidate control changes", () => {
  const before = { ...sample(227.997), metrics: { cpuUs: 1339.095, cpuRelative: 227.997 } };
  const after = {
    ...sample(453.192, "b".repeat(40)),
    metrics: { cpuUs: 1787.4, cpuRelative: 453.192 },
  };
  assert.equal(comparePairedCpu(before, after).status, "pass");
  assert.equal(
    comparePairedCpu(before, {
      ...after,
      metrics: { cpuUs: 2 * before.metrics.cpuUs, cpuRelative: 100 },
    }).status,
    "fail",
  );
  assert.equal(
    comparePairedCpu(before, { ...after, profileHash: "d".repeat(64) }).status,
    "unknown",
  );
  assert.equal(
    comparePairedCpu({ ...before, metrics: { cpuUs: 0, cpuRelative: 0 } }, after).status,
    "unknown",
  );
});

test("paired CPU uses all fixed rounds and rejects sustained regressions without selecting a fast result", () => {
  const before = aggregateCpuRounds(
    [2, 3, 2].map((n) => [sample(n)]),
    ceilings(),
  );
  const stable = aggregateCpuRounds(
    [2, 100, 3].map((n) => [sample(n, "b".repeat(40))]),
    ceilings(),
  );
  assert.equal(stable[0].metrics.cpuRelative, 3);
  assert.equal(compareCosts(before, stable).status, "pass");
  const slower = aggregateCpuRounds(
    [2, 8, 8].map((n) => [sample(n, "b".repeat(40))]),
    ceilings(),
  );
  assert.equal(slower[0].metrics.cpuRelative, 8);
  assert.equal(compareCosts(before, slower).status, "fail");
});

test("CPU aggregation requires three complete, comparable and clean rounds", () => {
  assert.throws(
    () => aggregateCpuRounds([[sample(2)], [sample(3)]], ceilings()),
    /missing_cpu_rounds/,
  );
  for (const bad of [
    [],
    [sample(2), sample(2)],
    [{ ...sample(2), checkoutClean: false }],
    [{ ...sample(2), sourceSha: "b".repeat(40) }],
    [{ ...sample(2), profileHash: "d".repeat(64) }],
    [{ ...sample(2), environment: "local-mock" }],
    [{ ...sample(2), metrics: { cpuRelative: null, cpuUs: 2 } }],
  ]) {
    assert.throws(() => aggregateCpuRounds([[sample(2)], bad, [sample(3)]], ceilings()));
  }
});

test("CPU medians preserve the source-controlled ceiling and require its evidence in every round", () => {
  const rounds = [40, 60, 70].map((n) => [sample(n)]);
  assert.throws(() => aggregateCpuRounds(rounds, ceilings()), /cpu_absolute_budget/);
  assert.throws(() => aggregateCpuRounds(rounds, [{}, {}, {}]), /missing_or_changed_cpu_ceiling/);
  assert.throws(
    () =>
      aggregateCpuRounds(rounds, [{ "cpu-parse": 50 }, { "cpu-parse": 100 }, { "cpu-parse": 50 }]),
    /missing_or_changed_cpu_ceiling/,
  );
  const log = JSON.stringify({
    event: "parser_cpu_benchmark",
    shopKey: "shop",
    stage: "parse",
    maxRelativeToReference: 35.5,
  });
  assert.deepEqual(parseCpuCeilings(`tool startup\n${log}\n`), { "cpu-shop-parse": 35.5 });
  assert.throws(() => parseCpuCeilings(`${log}\n${log}`), /duplicate_cpu_ceiling/);
});
