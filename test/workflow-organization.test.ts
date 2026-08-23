import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
const e2eWorkflow = readFileSync(new URL("e2e.yml", workflowDirectory), "utf8");
const ciWorkflow = readFileSync(new URL("ci.yml", workflowDirectory), "utf8");
const opsWorkflow = readFileSync(
  new URL("production-operational-health.yml", workflowDirectory),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  scripts?: Record<string, string>;
};

test("workflow count does not grow beyond the organized baseline", () => {
  const workflows = readdirSync(workflowDirectory).filter(
    (name) => /\.ya?ml$/u.test(name) && name !== "vitest-migration-bootstrap.yml",
  );
  assert.ok(workflows.length <= 17, `Expected at most 17 permanent workflows, found ${workflows.length}`);
});

test("production repair and duplicate search audit are not autonomous workflows", () => {
  assert.equal(existsSync(new URL("repair-product-search-gaps.yml", workflowDirectory)), false);
  assert.equal(existsSync(new URL("product-search-identity-audit.yml", workflowDirectory)), false);
  assert.match(opsWorkflow, /bash scripts\/product-search-identity-health\.sh/u);
  assert.equal(existsSync(new URL("scripts/repair-product-search-gaps.ts", root)), true);
});

test("E2E uses the root locked toolchain and excludes protected admin API monitoring", () => {
  assert.match(e2eWorkflow, /uses: \.\/\.github\/actions\/setup-node-deps/u);
  assert.match(e2eWorkflow, /run: npm run test:e2e/u);
  assert.doesNotMatch(e2eWorkflow, /npm install --no-package-lock/u);
  assert.doesNotMatch(ciWorkflow, /npm install --no-package-lock/u);
  assert.equal(existsSync(new URL("e2e/package.json", root)), false);
  assert.equal(existsSync(new URL("e2e/tests/data-quality-api.spec.ts", root)), false);
  assert.equal(
    packageJson.scripts?.["test:e2e"],
    "playwright test --config e2e/playwright.config.ts",
  );
});