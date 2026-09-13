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
  assert.throws(
    () => parseLoopSpec({ ...example, delivery: { ...example.delivery, target: "deployment" } }),
    /deployment_gate/u,
  );
  assert.throws(() => parseLoopSpec({ ...example, task: { ...example.task, requirements: [] } }));
});
