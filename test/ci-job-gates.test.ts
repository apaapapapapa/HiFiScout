import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const resolveLoadBase = ci
  .split("      - name: Resolve the baseline of the tested source\n")[1]
  .split("        run: |\n")[1]
  .split("      - uses:")[0]
  .split("\n")
  .map((line) => line.replace(/^          /u, ""))
  .join("\n");

test("load baseline follows the tested merge parent when main advances and rejects unbound sources", () => {
  const root = mkdtempSync(join(tmpdir(), "load-base-"));
  const output = join(root, "output");
  const git = (...args: string[]) => {
    const r = spawnSync(
      "git",
      ["-c", "user.name=Load gate test", "-c", "user.email=load-test@example.invalid", ...args],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    git("init", "--initial-branch=main");
    git("commit", "--allow-empty", "-m", "old base");
    const oldBase = git("rev-parse", "HEAD");
    git("switch", "-c", "candidate");
    git("commit", "--allow-empty", "-m", "candidate");
    const candidate = git("rev-parse", "HEAD");
    git("switch", "main");
    git("commit", "--allow-empty", "-m", "concurrent main update");
    const currentBase = git("rev-parse", "HEAD");
    git("merge", "--no-ff", "candidate", "-m", "tested merge");
    const tested = git("rev-parse", "HEAD");
    const check = (event: string, before = oldBase, sha = tested) => {
      writeFileSync(output, "");
      const r = spawnSync("bash", ["-c", resolveLoadBase], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          LOAD_EVENT_NAME: event,
          LOAD_EVENT_BEFORE: before,
          LOAD_CANDIDATE_SHA: sha,
        },
      });
      return { status: r.status, output: readFileSync(output, "utf8") };
    };
    assert.deepEqual(check("pull_request"), { status: 0, output: `sha=${currentBase}\n` });
    assert.deepEqual(check("push"), { status: 0, output: `sha=${oldBase}\n` });
    assert.notEqual(check("pull_request", oldBase, candidate).status, 0);
    assert.notEqual(check("push", "0".repeat(40)).status, 0);
    git("switch", "--detach", candidate);
    assert.notEqual(check("pull_request", oldBase, candidate).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const fanOut = ci
  .split("      - name: Verify CI fan-out\n")[1]
  .split("        run: |\n")[1]
  .split("      - name:")[0]
  .split("\n")
  .map((line) => line.replace(/^          /u, ""))
  .join("\n");

test("required CI gate accepts only the job results required by the detected scope", () => {
  const check = (environment: Record<string, string>) =>
    spawnSync("bash", ["-c", fanOut], {
      env: { ...process.env, ...environment },
      encoding: "utf8",
    }).status;
  const applicationJobs = [
    "UNIT_RESULT",
    "REPLAY_RESULT",
    "LOAD_BASELINE_RESULT",
    "INTEGRATION_RESULT",
    "MIGRATION_RESULT",
    "COMPONENT_RESULT",
    "DEPENDENCY_RESULT",
  ];
  for (const scope of ["markdown", "docs-asset", "application"] as const) {
    const application = scope === "application";
    const results = {
      SCOPE_RESULT: "success",
      MARKDOWN_ONLY: String(scope === "markdown"),
      APPLICATION: String(application),
      STATIC_RESULT: scope === "markdown" ? "skipped" : "success",
      ...Object.fromEntries(
        applicationJobs.map((name) => [name, application ? "success" : "skipped"]),
      ),
    };
    assert.equal(check(results), 0, scope);
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      assert.notEqual(check({ ...results, SCOPE_RESULT: result }), 0, result);
    }
    for (const name of ["STATIC_RESULT", ...applicationJobs]) {
      assert.notEqual(check({ ...results, [name]: "failure" }), 0, name);
      assert.notEqual(check({ ...results, [name]: "cancelled" }), 0, name);
      assert.notEqual(
        check({
          ...results,
          [name]: results[name as keyof typeof results] === "success" ? "skipped" : "success",
        }),
        0,
        name,
      );
    }
    assert.notEqual(check({ ...results, APPLICATION: "" }), 0);
  }
});

const downstream = readFileSync(
  new URL("../.github/actions/deployment-run-scope/action.yml", import.meta.url),
  "utf8",
)
  .split("      run: |\n")[1]
  .split("\n")
  .map((line) => line.replace(/^        /u, ""))
  .join("\n");

test("downstream gate skips only an explicitly unchanged deployment and preserves unknown/failure evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "deployment-scope-"));
  const output = join(root, "output");
  try {
    writeFileSync(
      join(root, "gh"),
      '#!/bin/sh\nprintf "%s" "$TEST_JOB_PAGES"\nexit "${TEST_API_STATUS:-0}"\n',
      { mode: 0o755 },
    );
    const check = (pages: unknown, runId = "123", apiStatus = "0") => {
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-c", downstream], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH || "/usr/bin:/bin"}`,
          GITHUB_REPOSITORY: "test/fixture",
          DEPLOY_RUN_ID: runId,
          GITHUB_OUTPUT: output,
          TEST_JOB_PAGES: JSON.stringify(pages),
          TEST_API_STATUS: apiStatus,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(output, "utf8");
    };
    const jobs = (preflight: string, deploy: string) => [
      { jobs: [{ name: "changes", conclusion: preflight }] },
      { jobs: [{ name: "deploy", conclusion: deploy }] },
    ];
    assert.equal(check(jobs("success", "skipped")), "required=false\n");
    for (const [preflight, deploy] of [
      ["success", "success"],
      ["success", "failure"],
      ["failure", "skipped"],
      ["cancelled", "skipped"],
      ["skipped", "skipped"],
    ]) {
      assert.equal(check(jobs(preflight, deploy)), "required=true\n");
    }
    assert.equal(check([{ jobs: [{ name: "deploy", conclusion: "success" }] }]), "required=true\n");
    assert.equal(check([]), "required=true\n");
    assert.equal(check({ malformed: true }), "required=true\n");
    assert.equal(check(jobs("success", "skipped"), "123", "1"), "required=true\n");
    assert.equal(check(jobs("success", "skipped"), ""), "required=true\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
