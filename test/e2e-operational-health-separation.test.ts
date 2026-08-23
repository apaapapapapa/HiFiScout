import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const e2eWorkflow = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
const operationalWorkflow = readFileSync(
  new URL("../.github/workflows/production-operational-health.yml", import.meta.url),
  "utf8",
);
const knowledgeCatalogMonitor = readFileSync(
  new URL("../scripts/knowledge-catalog-operational-health.sh", import.meta.url),
  "utf8",
);

test("browser E2E owns user-flow regression only", () => {
  assert.match(e2eWorkflow, /Run Playwright user-flow regression suite/u);
  assert.doesNotMatch(e2eWorkflow, /api\/knowledge-catalog\/status/u);
  assert.doesNotMatch(e2eWorkflow, /Knowledge Catalog operational status/u);
  assert.doesNotMatch(e2eWorkflow, /sleep 30/u);
});

test("post-deploy operational health owns data and Knowledge Catalog monitoring independently", () => {
  assert.match(operationalWorkflow, /\n  data-platform:\n/u);
  assert.match(operationalWorkflow, /bash scripts\/production-operational-health\.sh/u);
  assert.match(operationalWorkflow, /\n  knowledge-catalog:\n/u);
  assert.match(operationalWorkflow, /bash scripts\/knowledge-catalog-operational-health\.sh/u);
  assert.match(operationalWorkflow, /PRODUCTION_BASE_URL/u);
});

test("Knowledge Catalog monitor checks verifier, queue progress, and review state", () => {
  assert.match(knowledgeCatalogMonitor, /api\/knowledge-catalog\/status/u);
  assert.match(knowledgeCatalogMonitor, /\.verifier\.status/u);
  assert.match(knowledgeCatalogMonitor, /\.queue\.latestRunId/u);
  assert.match(knowledgeCatalogMonitor, /\.queue\.latestRun\.completed/u);
  assert.match(knowledgeCatalogMonitor, /\.queue\.latestRun\.deadLetter/u);
  assert.match(knowledgeCatalogMonitor, /\.latestReview\.status/u);
  assert.match(knowledgeCatalogMonitor, /for attempt in \$\(seq 1 16\)/u);
});
