import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const convergenceScriptPath = "scripts/wait-for-active-crawl-convergence.sh";
const workflowPath = ".github/workflows/production-operational-health.yml";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("active crawl convergence gate is valid bash", () => {
  execFileSync("bash", ["-n", convergenceScriptPath], { stdio: "pipe" });
});

test("active crawl convergence gate waits only for identity gaps owned by active crawl sessions", () => {
  const script = read(convergenceScriptPath);

  assert.match(script, /s\.status IN \('collecting', 'finalizing'\)/);
  assert.match(script, /p\.shop_key = s\.shop_key/);
  assert.match(script, /p\.is_active = 1/);
  assert.match(script, /r\.listing_product_id IS NULL/);
  assert.match(script, /ACTIVE_CRAWL_CONVERGENCE_MAX_WAIT_SECONDS:-480/);
  assert.match(script, /continuing to the strict health checks/);
  assert.doesNotMatch(script, /exit 1\s*#.*convergence/i);
});

test("production operational health runs convergence gate before strict checks", () => {
  const workflow = read(workflowPath);
  const waitIndex = workflow.indexOf("bash scripts/wait-for-active-crawl-convergence.sh");
  const strictIndex = workflow.indexOf("bash scripts/production-operational-health.sh");

  assert.ok(waitIndex >= 0, "workflow must invoke the active-crawl convergence gate");
  assert.ok(strictIndex > waitIndex, "strict production health must run after convergence wait");
  assert.match(workflow, /data-platform:[\s\S]*?timeout-minutes: 20/);
});
