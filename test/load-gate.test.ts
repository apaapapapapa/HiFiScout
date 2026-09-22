import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  evaluateLoadGate,
  loadCoverage,
  loadDigest,
  parseLoadReviews,
  sampleReviewDigest,
} from "../scripts/harness/load-gate.js";
import type { LoadGateInput } from "../scripts/harness/load-gate.js";
import type { CostSample } from "../scripts/harness/cost.js";

const BASE = "a".repeat(40),
  HEAD = "b".repeat(40);
const sample = (sourceSha: string): CostSample => ({
  schemaVersion: 1,
  kind: "cost-sample",
  id: "lookup",
  sourceSha,
  checkoutClean: true,
  recordedAt: "2026-09-22T00:00:00Z",
  profileHash: "c".repeat(64),
  environment: "local-workerd",
  metrics: { rowsRead: 100, rowsWritten: 0, sqlStatements: 2 },
  notes: [],
  queryPlans: [],
});
const contract = {
  id: "lookup",
  sources: ["src/db/lookup.ts"],
  suites: ["test/lookup-budget.test.ts"],
  samples: {
    lookup: {
      environment: "local-workerd",
      limits: { rowsRead: 200, rowsWritten: 0, sqlStatements: 2 },
    },
  },
  reason: "A bounded lookup preserves zero-write behavior.",
};
function report(status = "passed", suiteStatus = "passed") {
  return {
    testResults: [
      {
        name: "/repo/test/lookup-budget.test.ts",
        status: suiteStatus,
        message: "",
        assertionResults: [{ fullName: "lookup stays bounded", status, failureMessages: [] }],
      },
    ],
  };
}
function input(): LoadGateInput {
  return {
    baseSha: BASE,
    sourceSha: HEAD,
    checkoutClean: true,
    before: [sample(BASE)],
    after: [sample(HEAD)],
    beforeContracts: [structuredClone(contract)],
    afterContracts: [structuredClone(contract)],
    beforeRequired: ["lookup"],
    afterRequired: ["lookup"],
    beforeReports: [report()],
    afterReports: [report()],
    changedPaths: ["src/db/lookup.ts"],
    reviews: [],
  };
}

test("equal complete workloads pass and a relative regression fails below the absolute ceiling", () => {
  const data = input();
  assert.equal(evaluateLoadGate(data).status, "pass");
  data.after = [{ ...sample(HEAD), metrics: { rowsRead: 101, rowsWritten: 0, sqlStatements: 2 } }];
  assert.ok(evaluateLoadGate(data).problems.includes("comparison_fail:lookup"));
  data.after = [{ ...sample(HEAD), metrics: { rowsRead: 1, rowsWritten: 1, sqlStatements: 1 } }];
  assert.ok(evaluateLoadGate(data).problems.includes("absolute_budget_or_measurement:lookup"));
});

test("unregistered SQL paths and renames cannot borrow an unrelated contract", () => {
  assert.deepEqual(loadCoverage(["src/db/new-loader.ts"], [contract]).uncovered, [
    "src/db/new-loader.ts",
  ]);
  assert.deepEqual(
    loadCoverage(["src/db/lookup.ts", "src/new-path.ts"], [contract], {
      "src/new-path.ts": "env.DB.prepare(sql)",
    }).uncovered,
    ["src/new-path.ts"],
  );
  assert.equal(loadCoverage(["docs/notes.md"], [contract]).uncovered.length, 0);
});

test("missing, stale, dirty and duplicate samples never count as cheap work", () => {
  for (const mutation of [
    (d: LoadGateInput) => {
      d.before = [];
    },
    (d: LoadGateInput) => {
      d.after = [];
    },
    (d: LoadGateInput) => {
      d.after = [sample(BASE)];
    },
    (d: LoadGateInput) => {
      d.checkoutClean = false;
    },
    (d: LoadGateInput) => {
      d.after = [sample(HEAD), sample(HEAD)];
    },
    (d: LoadGateInput) => {
      d.after = [{ ...sample(HEAD), checkoutClean: false }];
    },
    (d: LoadGateInput) => {
      d.after = [
        { ...sample(HEAD), metrics: { rowsRead: null, rowsWritten: 0, sqlStatements: 2 } },
      ];
    },
    (d: LoadGateInput) => {
      d.after = [{ ...sample(HEAD), metrics: { rowsRead: 100, sqlStatements: 2 } }];
    },
  ]) {
    const data = input();
    mutation(data);
    assert.equal(evaluateLoadGate(data).status, "fail");
  }
});

test("real suite outcomes are required even when every cost sample exists", () => {
  for (const reports of [
    [report("pending")],
    [report("passed", "failed")],
    [report("failed")],
    [],
  ]) {
    const data = input();
    data.afterReports = reports;
    assert.equal(evaluateLoadGate(data).status, "fail");
  }
  const data = input();
  data.beforeReports = [report("pending")];
  assert.equal(evaluateLoadGate(data).status, "fail");
});

test("CPU diagnostics cannot disappear from both sides of a relative comparison", () => {
  const data = input();
  data.beforeRequired.push("cpu-parse");
  data.afterRequired.push("cpu-parse");
  for (const [samples, sha] of [
    [data.before, BASE],
    [data.after, HEAD],
  ] as const) {
    samples.push({
      ...sample(sha),
      id: "cpu-parse",
      environment: "local-node",
      metrics: { cpuRelative: 1 },
    });
  }
  assert.ok(evaluateLoadGate(data).problems.includes("missing_metric:cpu-parse"));
});

test("a budget increase is independently blocked even when actual measurements are unchanged", () => {
  const data = input();
  data.afterContracts[0].samples.lookup.limits.rowsRead = 300;
  assert.ok(
    evaluateLoadGate(data).problems.includes("load_policy_change_requires_evidence_review"),
  );
});

function reviewFor(data: LoadGateInput) {
  return parseLoadReviews({
    schemaVersion: 1,
    reviews: [
      {
        id: "lookup",
        baseSha: BASE,
        beforeDigest: sampleReviewDigest(data.before[0] as CostSample, data.beforeContracts),
        afterDigest: sampleReviewDigest(data.after[0] as CostSample, data.afterContracts),
        reason:
          "Reviewed fixture expansion with both measurement reports retained; no production improvement is claimed.",
        evidence: ["https://github.com/apaapapapapa/HiFiScout/pull/711"],
      },
    ],
  });
}

test("a reviewed profile change remains explicit and binds the exact base, profiles and observations", () => {
  const data = input();
  data.after = [{ ...sample(HEAD), profileHash: "d".repeat(64) }];
  assert.equal(evaluateLoadGate(data).status, "fail");
  data.reviews = reviewFor(data);
  let result = evaluateLoadGate(data);
  assert.equal(result.status, "pass");
  assert.equal(result.rows[0].status, "reviewed_baseline");
  assert.equal(result.rows[0].comparison?.status, "unknown");
  data.reviews[0].baseSha = HEAD;
  assert.equal(evaluateLoadGate(data).status, "fail");
  data.reviews = reviewFor(data);
  data.after = [
    {
      ...sample(HEAD),
      profileHash: "d".repeat(64),
      metrics: { rowsRead: 101, rowsWritten: 0, sqlStatements: 2 },
    },
  ];
  result = evaluateLoadGate(data);
  assert.equal(result.status, "fail");
});

test("a review never permits missing metadata, an environment downgrade or an absolute overrun", () => {
  for (const current of [
    { ...sample(HEAD), metrics: { rowsRead: null, rowsWritten: 0, sqlStatements: 2 } },
    { ...sample(HEAD), metrics: { rowsRead: 100, sqlStatements: 2 } },
    { ...sample(HEAD), metrics: { rowsRead: 201, rowsWritten: 0, sqlStatements: 2 } },
    { ...sample(HEAD), environment: "local-mock" as const },
  ]) {
    const data = input();
    data.after = [current];
    data.reviews = reviewFor(data);
    assert.equal(evaluateLoadGate(data).status, "fail");
  }
});

test("review records cannot remove an absolute budget or substitute mocked CPU", () => {
  const removed = input();
  delete removed.afterContracts[0].samples.lookup;
  removed.reviews = reviewFor(removed).map((r) => ({
    ...r,
    id: "load-contracts",
    beforeDigest: loadDigest(removed.beforeContracts),
    afterDigest: loadDigest(removed.afterContracts),
  }));
  assert.ok(evaluateLoadGate(removed).problems.includes("missing_absolute_budget:lookup"));

  const cpu = input();
  const before = {
    ...sample(BASE),
    id: "cpu-parse",
    environment: "local-node" as const,
    metrics: { cpuUs: 100, cpuRelative: 1 },
  };
  const after = { ...before, sourceSha: HEAD, environment: "local-mock" as const };
  cpu.before.push(before);
  cpu.after.push(after);
  cpu.beforeRequired.push(before.id);
  cpu.afterRequired.push(after.id);
  cpu.reviews = reviewFor(cpu).map((r) => ({
    ...r,
    id: after.id,
    beforeDigest: sampleReviewDigest(before, cpu.beforeContracts),
    afterDigest: sampleReviewDigest(after, cpu.afterContracts),
  }));
  assert.ok(evaluateLoadGate(cpu).problems.includes("cpu_measurement_environment:cpu-parse"));
});

test("review records require a reason, durable repository evidence and unambiguous identities", () => {
  assert.equal(loadDigest({ b: 1, a: 2 }), loadDigest({ a: 2, b: 1 }));
  assert.throws(
    () => parseLoadReviews({ schemaVersion: 1, reviews: [{ id: "*", reason: "pass" }] }),
    /invalid_load_review/,
  );
  const data = input();
  const [review] = reviewFor(data);
  assert.throws(
    () => parseLoadReviews({ schemaVersion: 1, reviews: [review, review] }),
    /duplicate_load_review/,
  );
});
