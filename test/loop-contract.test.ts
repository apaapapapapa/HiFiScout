import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import example from "../.github/harness/loop.example.json";
import { loopSpecDigest, parseLoopSpec, pathAllowed } from "../scripts/harness/loop/contract.js";

test("loop contracts freeze acceptance, scope, budget and delivery policy", () => {
  const spec = parseLoopSpec(example);
  for (const changed of [
    { ...spec, budget: { ...spec.budget, maxIterations: 4 } },
    { ...spec, allowedPaths: ["src"] },
    { ...spec, task: { ...spec.task, requirements: [{ id: "other", scope: "source" }] } },
    { ...spec, delivery: { ...spec.delivery, target: "merge" } },
  ])
    assert.notEqual(loopSpecDigest(changed), loopSpecDigest(spec));
  assert.equal(pathAllowed(spec, "src/catalog/classifier.ts"), true);
  for (const path of [
    ".github/workflows/ci.yml",
    "test/loop-contract.test.ts",
    "test/harness-ai.test.ts",
    "scripts/harness.ts",
    "src/types.ts",
    "scripts/check-no-first-party-js.ts",
    ".dependency-cruiser.json",
    "src/AGENTS.md",
    "migrations/new.sql",
    "src-other/file.ts",
  ])
    assert.equal(pathAllowed(spec, path), false);
  assert.throws(() => pathAllowed(spec, "src/../AGENTS.md"), /invalid_loop_path/u);
});

test("malformed budgets and acceptance cannot become permissive defaults", () => {
  for (const value of [0, -1, 21, NaN, Infinity, "3"])
    assert.throws(() =>
      parseLoopSpec({ ...example, budget: { ...example.budget, maxIterations: value } }),
    );
  assert.throws(() => parseLoopSpec({ ...example, allowedPaths: ["src/"] }));
  const deployed = parseLoopSpec({
    ...example,
    delivery: { ...example.delivery, target: "deployment", review: "required" },
  });
  for (const id of [
    "ci",
    "review-threads",
    "main-merge",
    "deployment",
    "deployment/catalog-admin",
    "verification/e2e",
    "review-approval",
  ])
    assert.ok(deployed.task.requirements.some((r) => r.id === id));
  assert.throws(
    () =>
      parseLoopSpec({
        ...example,
        task: {
          ...example.task,
          requirements: [...example.task.requirements, { id: "deployment", scope: "source" }],
        },
        delivery: { ...example.delivery, target: "deployment" },
      }),
    /gate_scope/u,
  );
  assert.throws(() => parseLoopSpec({ ...example, task: { ...example.task, requirements: [] } }));
});

test("domain loops cannot opt out of their comparison or AI gate", () => {
  for (const kind of ["product", "cost"])
    assert.throws(() => parseLoopSpec({ ...example, kind }), /requires_comparison/u);
  assert.deepEqual(
    parseLoopSpec({ ...example, kind: "product", comparisons: ["replay"] }).comparisons,
    ["replay"],
  );
  assert.deepEqual(parseLoopSpec({ ...example, kind: "cost", comparisons: ["cost"] }).comparisons, [
    "cost",
  ]);
  assert.ok(
    parseLoopSpec({ ...example, kind: "ai" }).task.requirements.some((r) => r.id === "ai:holdout"),
  );
  const broad = parseLoopSpec({
    ...example,
    allowedPaths: ["scripts", "src", ".dependency-cruiser.json"],
  });
  assert.equal(pathAllowed(broad, "scripts/check-no-first-party-js.ts"), false);
  assert.equal(pathAllowed(broad, ".dependency-cruiser.json"), false);
});
