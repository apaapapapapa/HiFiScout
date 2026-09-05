import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

const deployWorkflowUrl = new URL("../.github/workflows/deploy.yml", import.meta.url);
const resolverReplayWorkflowUrl = new URL(
  "../.github/workflows/resolver-replay-drain.yml",
  import.meta.url,
);
const legacyDeployStatusUrl = new URL("../.github/workflows/deploy-status.yml", import.meta.url);
const deployWorkflow = readFileSync(deployWorkflowUrl, "utf8");
const resolverReplayWorkflow = readFileSync(resolverReplayWorkflowUrl, "utf8");

// Execute the actual workflow shell with a local GitHub API stub. This reproduces the rollout
// race where new workflow YAML tried to run test:migrations in an older approved checkout.
for (const event of ["schedule", "workflow_run"] as const) {
  test(`${event} skips an older CI target without exporting a deployment SHA`, () => {
    const current = "a".repeat(40);
    const previous = "b".repeat(40);
    const body = deployWorkflow.match(
      /name: Resolve deployment target[\s\S]*?        run: \|\n([\s\S]*?)\n      - uses: actions\/checkout/u,
    )?.[1];
    assert.ok(body);
    const script = body
      .split("\n")
      .map((line) => line.replace(/^          /u, ""))
      .join("\n");
    const directory = mkdtempSync(join(tmpdir(), "deploy-target-"));
    try {
      writeFileSync(
        join(directory, "gh"),
        '#!/bin/sh\ncase "$*" in\n  *actions/workflows/ci.yml/runs*) printf "%s\\n" "$TEST_CI_SHA" ;;\n  *commits/*/status*) printf "success\\tCloudflare deployment deferred by D1 quota: success\\n" ;;\n  *) exit 2 ;;\nesac\n',
        { mode: 0o755 },
      );
      for (const target of [previous, current]) {
        const output = join(directory, "output");
        const environment = join(directory, "environment");
        writeFileSync(output, "");
        writeFileSync(environment, "");
        execFileSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH || "/usr/bin:/bin"}`,
            EVENT_NAME: event,
            EVENT_SHA: current,
            WORKFLOW_RUN_SHA: target,
            TEST_CI_SHA: target,
            GITHUB_REPOSITORY: "test/fixture",
            GITHUB_OUTPUT: output,
            GITHUB_ENV: environment,
          },
        });
        if (target === previous) {
          assert.equal(readFileSync(output, "utf8"), "available=false\n");
          assert.equal(readFileSync(environment, "utf8"), "");
        } else {
          assert.equal(readFileSync(output, "utf8"), `available=true\nsha=${current}\n`);
          assert.equal(readFileSync(environment, "utf8"), `DEPLOY_SHA=${current}\n`);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("deployment status is owned by the workflow that knows the deployed SHA", () => {
  assert.match(deployWorkflow, /echo "DEPLOY_SHA=\$target_sha" >> "\$GITHUB_ENV"/u);
  assert.match(deployWorkflow, /ref: \$\{\{ steps\.target\.outputs\.sha \}\}/u);
  assert.match(deployWorkflow, /if: always\(\) && steps\.target\.outputs\.available == 'true'/u);
  assert.match(deployWorkflow, /uses: \.\/\.github\/actions\/publish-commit-status/u);
  assert.match(deployWorkflow, /sha: \$\{\{ env\.DEPLOY_SHA \}\}/u);
  assert.match(deployWorkflow, /context: deployment\/cloudflare/u);
  assert.equal(existsSync(legacyDeployStatusUrl), false);
});

test("production workflows use the shared Vite+ package-manager bootstrap", () => {
  for (const [name, workflow] of [
    ["deployment", deployWorkflow],
    ["resolver replay", resolverReplayWorkflow],
  ] as const) {
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-node-deps/u, name);
    assert.doesNotMatch(workflow, /uses: actions\/setup-node@/u, name);
    assert.doesNotMatch(workflow, /- run: npm ci/u, name);
  }
});
