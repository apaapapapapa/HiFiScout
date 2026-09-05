import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

// Exercise the actual composite action with Git commits, including a deferred production baseline.
const action = readFileSync(
  new URL("../.github/actions/change-scope/action.yml", import.meta.url),
  "utf8",
);
const shell = action
  .split("      run: |\n")[1]
  .split("\n")
  .map((line) => line.replace(/^        /u, ""))
  .join("\n");

test("documentation detection preserves pending code, renames and unknown comparison bases", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-scope-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = (name: string) => {
    git("add", ".");
    git("commit", "-qm", name);
    return git("rev-parse", "HEAD");
  };
  const classify = (base: string) => {
    const output = join(root, ".git", "scope-output");
    writeFileSync(output, "");
    execFileSync("bash", ["-c", shell], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BASE_REF: base, HEAD_REF: "HEAD", GITHUB_OUTPUT: output },
    });
    return readFileSync(output, "utf8");
  };
  try {
    git("init", "-q");
    git("config", "user.name", "fixture");
    git("config", "user.email", "fixture@example.test");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "src", "worker.ts"), "export const version = 1;\n");
    const production = commit("production");
    writeFileSync(join(root, "src", "worker.ts"), "export const version = 2;\n");
    const deferred = commit("code awaiting deployment");
    writeFileSync(join(root, "docs", "guide.md"), "Documentation\n");
    commit("docs only");
    assert.equal(classify(deferred), "application=false\n");
    assert.equal(
      classify(production),
      "application=true\n",
      "unreleased code still needs deployment",
    );
    assert.equal(classify("0".repeat(40)), "application=true\n");
    assert.equal(classify(""), "application=true\n");
    const beforeRename = git("rev-parse", "HEAD");
    git("mv", "src/worker.ts", "docs/worker.ts");
    commit("move into docs");
    assert.equal(
      classify(beforeRename),
      "application=true\n",
      "source deletion cannot hide behind a docs rename",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
