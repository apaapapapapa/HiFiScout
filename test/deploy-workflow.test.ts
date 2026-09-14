import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  rmSync,
} from "node:fs";
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

// Exercise the deployed-baseline comparison with real Git rename detection. R100 used to be
// excluded by --diff-filter=AM, bypassing the remote check for missing applied filenames.
for (const change of ["rename", "delete", "add", "modify", "unrelated"] as const) {
  test(`deployment migration preflight selection: ${change}`, () => {
    const body = deployWorkflow.match(
      /          changed_migrations=([\s\S]*?)\n      - uses:/u,
    )?.[1];
    assert.ok(body);
    const script = `changed_migrations=${body.replace(/^ {10}/gmu, "")}`;
    const directory = mkdtempSync(join(tmpdir(), "deploy-migration-diff-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    try {
      git("init", "--quiet");
      git("config", "user.name", "Deployment test");
      git("config", "user.email", "deployment@example.test");
      git("config", "diff.renames", "true");
      mkdirSync(join(directory, "migrations"));
      const oldPath = join(directory, "migrations/0127_taket_ws_catalog.sql");
      writeFileSync(oldPath, "SELECT 1;\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "deployed baseline");
      const baseline = git("rev-parse", "HEAD");
      if (change === "rename") {
        renameSync(oldPath, join(directory, "migrations/0128_taket_ws_catalog.sql"));
      } else if (change === "delete") {
        rmSync(oldPath);
      } else if (change === "add") {
        writeFileSync(join(directory, "migrations/0128_next.sql"), "SELECT 2;\n");
      } else if (change === "modify") {
        writeFileSync(oldPath, "SELECT 2;\n");
      } else {
        writeFileSync(join(directory, "README.md"), "No migration change\n");
      }
      git("add", "-A");
      git("commit", "--quiet", "-m", "deployment target");
      if (change === "rename") {
        assert.match(git("diff", "--name-status", baseline, "HEAD"), /^R100\s/u);
      }
      const output = join(directory, "output");
      execFileSync("bash", ["-c", `set -euo pipefail\n${script}`], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          last_deployed_sha: baseline,
          DEPLOY_SHA: git("rev-parse", "HEAD"),
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(readFileSync(output, "utf8"), `required=${change !== "unrelated"}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

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
