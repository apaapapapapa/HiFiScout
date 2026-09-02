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
    /if: steps\.d1-migrations\.outputs\.already_deployed != 'true' && steps\.d1-apply\.outputs\.deferred != 'd1_daily_quota'/,
  );
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
