import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessLoopScope, collectLoopScope } from "../scripts/harness/loop/scope.js";
import { assessLoopSource } from "../scripts/harness/loop/controller.js";
import { loopCheckout, loopReport, loopScope, loopSha, loopSpec } from "./helpers/loop.js";

test("source acceptance binds both the frozen comparison baseline and a complete change scope", () => {
  const spec = loopSpec();
  spec.kind = "cost";
  spec.comparisons = ["cost"];
  const report = loopReport();
  report.checks.push({ ...report.checks[0], id: "comparison:cost" });
  assert.equal(assessLoopSource(spec, report, loopCheckout, loopScope).status, "pass");
  assert.equal(
    assessLoopSource(spec, { ...report, baselineSha: null }, loopCheckout, loopScope).status,
    "unknown",
  );
  assert.equal(assessLoopSource(spec, report, loopCheckout).status, "unknown");
  for (const path of [".github/workflows/ci.yml", "src/types.ts", "test/existing.test.ts"]) {
    const scope = {
      ...loopScope,
      changes: [{ path, status: "M", oldMode: "100644", newMode: "100644" }],
    };
    assert.equal(assessLoopScope(spec, loopSha, scope).status, "fail");
  }
  assert.equal(
    assessLoopScope(spec, loopSha, {
      ...loopScope,
      changes: [{ path: "src/link", status: "A", oldMode: "000000", newMode: "120000" }],
    }).status,
    "fail",
  );
});

test("scope collection reads actual Git objects and preserves the exact changed-file evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loop-git-scope-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "Loop test");
    git("config", "user.email", "loop@example.test");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/value.ts"), "export const value = 1;\n");
    await writeFile(join(cwd, ".gitignore"), ".generated/\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "baseline");
    const spec = loopSpec();
    spec.baselineSha = git("rev-parse", "HEAD");
    await writeFile(join(cwd, "src/value.ts"), "export const value = 2;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "candidate");
    const scope = await collectLoopScope(spec, cwd);
    assert.equal(scope.sourceSha, git("rev-parse", "HEAD"));
    assert.equal(scope.changes[0].path, "src/value.ts");
    assert.equal(assessLoopScope(spec, scope.sourceSha, scope).status, "pass");
    assert.deepEqual(JSON.parse(await readFile(join(cwd, scope.artifactUri), "utf8")), scope);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
