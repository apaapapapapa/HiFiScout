import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";

const readWorkflow = (name: string) => readFile(`.github/workflows/${name}`, "utf8");

test("Cloudflare deploy defers only the recognized D1 daily row-read quota", async () => {
  const workflow = await readWorkflow("deploy.yml");

  assert.match(workflow, /code: 7500/);
  assert.match(workflow, /exceeded D1's free tier daily row read limit/);
  assert.match(workflow, /deferred=d1_daily_quota/);
  assert.match(workflow, /cron: "15 0 \* \* \*"/);

  const migrations = workflow.indexOf("Apply backward-compatible D1 migrations");
  const deploy = workflow.indexOf("Deploy Worker and static assets");
  const identity = workflow.indexOf("Record deployment identity");
  assert.ok(migrations >= 0 && deploy > migrations && identity > deploy);
  assert.match(
    workflow.slice(identity),
    /steps\.runtime-smoke\.outputs\.deferred != 'd1_daily_quota'/,
  );
});

test("runtime smoke confirms D1 quota independently when tail correlation is unavailable", async () => {
  const workflow = await readWorkflow("deploy.yml");

  assert.match(workflow, /id: runtime-smoke/);
  assert.match(workflow, /wrangler tail hifiscout --format=json/);
  assert.match(workflow, /wrangler d1 execute DB --remote --command 'SELECT 1;'/);
  assert.match(workflow, /quota_probe_status != 0/);
  assert.match(workflow, /grep -Fq 'code: 7500' "\$quota_probe"/);
  assert.match(
    workflow,
    /grep -Fq "exceeded D1's free tier daily row read limit" "\$quota_probe"/,
  );
  assert.match(workflow, /echo "deferred=d1_daily_quota" >> "\$GITHUB_OUTPUT"/);
  assert.match(
    workflow,
    /steps\.d1-apply\.outputs\.deferred == 'd1_daily_quota' \|\| steps\.runtime-smoke\.outputs\.deferred == 'd1_daily_quota'/,
  );
});

test("scheduled retries use only the newest CI-approved quota-deferred SHA", async () => {
  const workflow = await readWorkflow("deploy.yml");

  assert.match(
    workflow,
    /actions\/workflows\/ci\.yml\/runs\?branch=main&status=success&per_page=1/,
  );
  assert.match(workflow, /\.context == "deployment\/cloudflare"/);
  assert.match(workflow, /Cloudflare deployment deferred by D1 quota/);
  assert.match(workflow, /ref: \$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.doesNotMatch(workflow, /DEPLOY_SHA:.*github\.sha/);
});

test("deployment baseline comes from the identity artifact content and is retained", async () => {
  const workflow = await readWorkflow("deploy.yml");

  assert.match(workflow, /actions\/artifacts\?name=deployment-identity&per_page=100/);
  assert.match(workflow, /actions\/artifacts\/\$\{artifact_id\}\/zip/);
  assert.match(workflow, /unzip -p "\$zip_file" deployment-sha\.txt/);
  assert.match(workflow, /last_deployed_sha="\$candidate"/);
  assert.match(workflow, /retention-days: 90/);
  assert.doesNotMatch(workflow, /last_deployed_sha="\$run_sha"/);
});

test("post-deploy workflows never substitute workflow_run.head_sha for a deferred deployment", async () => {
  for (const name of ["e2e.yml", "production-operational-health.yml", "deploy-catalog-admin.yml"]) {
    const workflow = await readWorkflow(name);
    assert.match(workflow, /continue-on-error: true/);
    assert.match(workflow, /deployment-sha\.txt/);
    assert.match(workflow, /available=false/);
    assert.match(workflow, /steps\.deployment\.outputs\.available == 'true'/);
  }
});
