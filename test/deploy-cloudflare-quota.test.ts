import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const workflow = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

test("production smoke prefers CF-Ray correlation and permits only an exact D1 quota fallback", () => {
  assert.doesNotMatch(workflow, /Detect exhausted D1 runtime quota/);
  assert.doesNotMatch(workflow, /SELECT id FROM products LIMIT 1/);
  assert.match(workflow, /wrangler tail hifiscout --format=json/);
  assert.match(workflow, /diagnostic_ray/);
  assert.match(workflow, /\[\[ -n "\$diagnostic_ray" \]\] && jq -se/);
  assert.match(workflow, /event\.request\.headers\["cf-ray"\]/);
  assert.doesNotMatch(workflow, /diagnostic_ray="\$\{diagnostic_ray%%-\*\}"/);
  assert.match(workflow, /CF-Ray=\$\{diagnostic_ray:-missing\}/);
  assert.match(workflow, /select\(\(\.event\.request\.headers\["cf-ray"\] \/\/ ""\) == \$ray\)/);
  assert.match(workflow, /D1_ERROR: Your account has exceeded D1's free tier daily row read limit/);
  assert.match(workflow, /correlated by CF-Ray/);

  assert.match(workflow, /wrangler d1 execute DB --remote --command 'SELECT 1;'/);
  assert.match(workflow, /quota_probe_status != 0/);
  assert.match(workflow, /grep -Fq 'code: 7500' "\$quota_probe"/);
  assert.match(workflow, /grep -Fq "exceeded D1's free tier daily row read limit" "\$quota_probe"/);
  assert.match(workflow, /echo "deferred=d1_daily_quota" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /steps\.runtime-smoke\.outputs\.deferred != 'd1_daily_quota'/);
});

test("generic 1101 and unrelated tail or D1 probe failures keep production smoke fail-closed", () => {
  const failureBranch = workflow.slice(
    workflow.indexOf("Production Atom feed returned HTTP ${feed_status}"),
    workflow.indexOf(
      "content_type=",
      workflow.indexOf("Production Atom feed returned HTTP ${feed_status}"),
    ),
  );
  assert.match(
    failureBranch,
    /Worker tail did not correlate this request to the D1 daily row-read quota signature/,
  );
  assert.match(failureBranch, /Diagnostic replay returned HTTP/);
  assert.doesNotMatch(failureBranch, /deferred=d1_daily_quota/);
  assert.match(failureBranch, /exit 1/);
});
