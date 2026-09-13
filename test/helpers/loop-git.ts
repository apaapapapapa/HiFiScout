import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopGit } from "../../scripts/harness/loop/workspace.js";
import { createLoopRun } from "../../scripts/harness/loop/state.js";
import { loopSpec } from "./loop.js";
import type { LoopSpec } from "../../scripts/harness/loop/contract.js";
export async function loopGitFixture(overrides: Partial<LoopSpec> = {}) {
  const root = await mkdtemp(join(tmpdir(), "loop-workspace-")),
    source = join(root, "source");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src/value.ts"), "export const value = 1;\n");
  await writeFile(join(source, ".gitignore"), ".generated/\n");
  loopGit(source, ["init", "-b", "main"]);
  loopGit(source, ["config", "user.email", "test@example.invalid"]);
  loopGit(source, ["config", "user.name", "Test"]);
  loopGit(source, ["remote", "add", "origin", "https://github.com/apaapapapapa/HiFiScout.git"]);
  loopGit(source, ["add", "."]);
  loopGit(source, ["commit", "-m", "fixture"]);
  const sha = loopGit(source, ["rev-parse", "HEAD"]),
    state = join(root, "state.json"),
    workspaces = join(root, "workspaces");
  await createLoopRun({ ...loopSpec(), ...overrides, baselineSha: sha }, state);
  return { root, source, sha, state, workspaces };
}
