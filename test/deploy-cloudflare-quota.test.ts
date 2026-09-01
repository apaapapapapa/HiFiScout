import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

test("production smoke is deferred only after D1 code 7500 is confirmed", () => {
  assert.match(workflow, /Detect exhausted D1 runtime quota/);
  assert.match(workflow, /SELECT 1 AS ok/);
  assert.match(workflow, /code: 7500/);
  assert.match(workflow, /PRODUCTION_RUNTIME_CHECK_DEFERRED=d1_daily_quota/);
  assert.match(workflow, /Production Atom\/catalog smoke check deferred because D1 code 7500 was confirmed/);
  assert.match(workflow, /Production runtime health check deferred because D1 code 7500 was confirmed/);
});

test("non-7500 D1 probe failures do not suppress production smoke", () => {
  assert.match(workflow, /D1 availability probe inconclusive/);
  assert.match(workflow, /production smoke checks will still run/);
});
