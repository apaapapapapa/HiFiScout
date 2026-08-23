import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const deployWorkflowUrl = new URL("../.github/workflows/deploy.yml", import.meta.url);
const legacyDeployStatusUrl = new URL("../.github/workflows/deploy-status.yml", import.meta.url);
const deployWorkflow = readFileSync(deployWorkflowUrl, "utf8");

test("deployment status is owned by the workflow that knows the deployed SHA", () => {
  assert.match(
    deployWorkflow,
    /DEPLOY_SHA: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/,
  );
  assert.match(deployWorkflow, /ref: \$\{\{ env\.DEPLOY_SHA \}\}/);
  assert.match(deployWorkflow, /if: always\(\)/);
  assert.match(deployWorkflow, /statuses\/\$\{DEPLOY_SHA\}/);
  assert.equal(existsSync(legacyDeployStatusUrl), false);
});
