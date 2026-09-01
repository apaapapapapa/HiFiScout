import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

test("production smoke is deferred only after the D1 daily row-read quota signature is confirmed", () => {
  assert.match(workflow, /Detect exhausted D1 runtime quota/);
  assert.match(workflow, /SELECT 1 AS ok/);
  assert.match(workflow, /grep -Fq 'code: 7500'/);
  assert.match(workflow, /exceeded D1's free tier daily row read limit/);
  assert.match(workflow, /PRODUCTION_RUNTIME_CHECK_DEFERRED=d1_daily_quota/);
  assert.match(
    workflow,
    /Production Atom\/catalog smoke check deferred because the D1 daily row-read quota signature was confirmed/,
  );
  assert.match(
    workflow,
    /Production runtime health check deferred because the D1 daily row-read quota signature was confirmed/,
  );
});

test("generic code 7500 and non-quota probe failures keep production smoke fail-closed", () => {
  assert.match(workflow, /D1 availability probe inconclusive/);
  assert.match(workflow, /did not confirm the free-tier daily row-read quota signature/);
  assert.match(workflow, /production smoke checks will still run/);
  assert.doesNotMatch(workflow, /1101.*PRODUCTION_RUNTIME_CHECK_DEFERRED/s);
});
