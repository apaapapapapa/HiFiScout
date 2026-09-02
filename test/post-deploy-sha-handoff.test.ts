import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const deploy = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const e2e = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
const operationalHealth = readFileSync(
  new URL("../.github/workflows/production-operational-health.yml", import.meta.url),
  "utf8",
);
const catalogAdmin = readFileSync(
  new URL("../.github/workflows/deploy-catalog-admin.yml", import.meta.url),
  "utf8",
);
const statusAction = readFileSync(
  new URL("../.github/actions/publish-commit-status/action.yml", import.meta.url),
  "utf8",
);

const downstreamWorkflows = [e2e, operationalHealth, catalogAdmin];

test("Deploy publishes the exact CI-authorized SHA only after production is confirmed", () => {
  assert.match(deploy, /DEPLOY_SHA:/u);
  assert.match(deploy, /printf '%s\\n' "\$DEPLOY_SHA" > deployment-sha\.txt/u);
  assert.match(deploy, /name: deployment-identity/u);
  assert.match(deploy, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);

  const applyMigrations = deploy.indexOf("Apply backward-compatible D1 migrations");
  const deployWorker = deploy.indexOf("Deploy Worker and static assets");
  const runtimeHealth = deploy.indexOf("Check production runtime health");
  const publishIdentity = deploy.indexOf("Publish deployment identity artifact");
  assert.ok(applyMigrations >= 0);
  assert.ok(deployWorker > applyMigrations);
  assert.ok(runtimeHealth > deployWorker);
  assert.ok(publishIdentity > runtimeHealth);

  const identitySection = deploy.slice(deploy.indexOf("Record deployment identity"));
  assert.match(identitySection, /steps\.d1-migrations\.outputs\.already_deployed != 'true'/u);
  assert.match(identitySection, /steps\.d1-apply\.outputs\.deferred != 'd1_daily_quota'/u);
});

test("every automatic post-deploy workflow resolves identity from the triggering Deploy artifact", () => {
  for (const workflow of downstreamWorkflows) {
    assert.match(workflow, /actions: read/u);
    assert.match(workflow, /statuses: write/u);
    assert.match(workflow, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u);
    assert.match(workflow, /name: deployment-identity/u);
    assert.match(workflow, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/u);
    assert.match(workflow, /deployment-sha\.txt/u);
    assert.match(workflow, /available=false/u);
    assert.match(workflow, /steps\.deployment\.outputs\.available == 'true'/u);
    assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u);
  }
});

test("deployment and post-deploy workflows use one commit-status implementation", () => {
  for (const workflow of [deploy, ...downstreamWorkflows]) {
    assert.match(workflow, /uses: \.\/\.github\/actions\/publish-commit-status/u);
  }
  assert.match(statusAction, /failure\|cancelled\) state=failure/u);
  assert.match(statusAction, /statuses\/\$\{STATUS_SHA\}/u);
});

test("E2E, Ops, and Catalog Admin publish independent status against the resolved deployed SHA", () => {
  assert.match(e2e, /sha: \$\{\{ steps\.deployment\.outputs\.sha \}\}/u);
  assert.match(e2e, /context: verification\/e2e/u);
  assert.match(operationalHealth, /context: operations\/data-platform/u);
  assert.match(operationalHealth, /context: operations\/knowledge-catalog/u);
  assert.match(catalogAdmin, /sha: \$\{\{ steps\.deployment\.outputs\.sha \}\}/u);
  assert.match(catalogAdmin, /context: deployment\/catalog-admin/u);
});
