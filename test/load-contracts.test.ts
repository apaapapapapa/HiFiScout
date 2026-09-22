import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "vite-plus/test";
import { assessCostBudget } from "../scripts/harness/cost.js";
import { LOAD_CONTRACTS } from "../scripts/harness/load-contracts.js";

test("load budgets reject read/write tradeoffs, zero-write regressions and missing measurements", () => {
  const limits = { rowsRead: 200, rowsWritten: 0, sqlStatements: 32 };
  assert.equal(
    assessCostBudget({ rowsRead: 99, rowsWritten: 0, sqlStatements: 26 }, limits),
    "pass",
  );
  assert.equal(
    assessCostBudget({ rowsRead: 10000, rowsWritten: 0, sqlStatements: 1 }, limits),
    "fail",
  );
  assert.equal(assessCostBudget({ rowsRead: 1, rowsWritten: 1, sqlStatements: 1 }, limits), "fail");
  assert.equal(
    assessCostBudget({ rowsRead: null, rowsWritten: 0, sqlStatements: 1 }, limits),
    "unknown",
  );
  assert.equal(assessCostBudget({ rowsRead: 0, rowsWritten: 0 }, limits), "unknown");
  assert.equal(
    assessCostBudget({ rowsRead: NaN, rowsWritten: 0, sqlStatements: 1 }, limits),
    "unknown",
  );
  assert.throws(
    () => assessCostBudget({ rowsRead: 1 }, { rowsRead: Infinity }),
    /invalid_cost_budget/,
  );
});

test("every registered workload has executable suites and uniquely owned finite sample budgets", async () => {
  const samples = new Set<string>();
  for (const contract of LOAD_CONTRACTS) {
    assert.ok(contract.sources.length && contract.suites.length && contract.reason.length > 20);
    for (const suite of contract.suites) await access(suite);
    for (const [id, budget] of Object.entries(contract.samples)) {
      assert.ok(!samples.has(id), `duplicate sample ${id}`);
      samples.add(id);
      assert.equal(assessCostBudget(budget.limits, budget.limits), "pass");
    }
  }
});
