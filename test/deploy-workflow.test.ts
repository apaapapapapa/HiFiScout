import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const deployWorkflowUrl = new URL("../.github/workflows/deploy.yml", import.meta.url);
const legacyDeployStatusUrl = new URL("../.github/workflows/deploy-status.yml", import.meta.url);
const deployWorkflow = readFileSync(deployWorkflowUrl, "utf8");

test("deployment status is owned by the workflow that knows the deployed SHA", () => {
  assert.match(
    deployWorkflow,
    /DEPLOY_SHA: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/u,
  );
  assert.match(deployWorkflow, /ref: \$\{\{ env\.DEPLOY_SHA \}\}/u);
  assert.match(deployWorkflow, /if: always\(\)/u);
  assert.match(deployWorkflow, /uses: \.\/\.github\/actions\/publish-commit-status/u);
  assert.match(deployWorkflow, /sha: \$\{\{ env\.DEPLOY_SHA \}\}/u);
  assert.match(deployWorkflow, /context: deployment\/cloudflare/u);
  assert.equal(existsSync(legacyDeployStatusUrl), false);
});
