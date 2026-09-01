import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

test("production smoke defers only when the failing Worker request is correlated to D1 row-read quota", () => {
  assert.doesNotMatch(workflow, /Detect exhausted D1 runtime quota/);
  assert.doesNotMatch(workflow, /SELECT id FROM products LIMIT 1/);
  assert.match(workflow, /wrangler tail hifiscout --format=json/);
  assert.match(workflow, /diagnostic_ray/);
  assert.match(workflow, /event\.request\.headers\["cf-ray"\]/);
  assert.match(workflow, /D1_ERROR: Your account has exceeded D1's free tier daily row read limit/);
  assert.match(workflow, /PRODUCTION_RUNTIME_CHECK_DEFERRED=d1_daily_quota/);
  assert.match(workflow, /correlated by CF-Ray/);
  assert.match(
    workflow,
    /Production runtime health check deferred because the failing production request was correlated/,
  );
});

test("generic 1101 and unrelated tail failures keep production smoke fail-closed", () => {
  assert.match(
    workflow,
    /Worker tail did not correlate this request to the D1 daily row-read quota signature/,
  );
  assert.match(workflow, /Diagnostic replay returned HTTP/);
  assert.doesNotMatch(workflow, /1101.*PRODUCTION_RUNTIME_CHECK_DEFERRED/s);
  assert.match(workflow, /exit 1/);
});
