import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "../../../src/types.js";
import { readCheckout } from "../checkpoint.js";
import { requireSha, requireText } from "../report.js";
import { updateJsonRevision } from "../store.js";
import { digest, integer } from "./contract.js";
import { assessLoopRun, recordLoopEvent } from "./controller.js";
import { assessLoopScope, readLoopChanges } from "./scope.js";
import { readLoopRun } from "./state.js";
import type { LoopRun } from "./state.js";

export interface LoopWorkspace {
  revision: number;
  specDigest: string;
  branch: string;
  headSha: string;
  iteration: number;
  patchDigest: string | null;
  pending: { baseSha: string; candidateSha: string } | null;
}

function parseWorkspace(value: unknown): LoopWorkspace {
  if (!isRecord(value) || !/^[a-f0-9]{64}$/u.test(String(value.specDigest)))
    throw new Error("invalid_loop_workspace");
  if (value.patchDigest !== null && !/^[a-f0-9]{64}$/u.test(String(value.patchDigest)))
    throw new Error("invalid_patch_digest");
  if (value.pending !== null && !isRecord(value.pending)) throw new Error("invalid_pending_patch");
  return {
    revision: integer(value.revision, "workspace_revision", 1),
    specDigest: String(value.specDigest),
    branch: requireText(value.branch, "workspace_branch"),
    headSha: requireSha(value.headSha),
    iteration: integer(value.iteration, "workspace_iteration"),
    patchDigest: value.patchDigest as string | null,
    pending: isRecord(value.pending)
      ? {
          baseSha: requireSha(value.pending.baseSha),
          candidateSha: requireSha(value.pending.candidateSha),
        }
      : null,
  };
}

export function loopGit(
  cwd: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 2_097_152,
    ...options,
  }).trimEnd();
}

async function paths(root: string, run: LoopRun) {
  await mkdir(root, { recursive: true });
  const canonical = await realpath(root);
  const workspace = join(canonical, run.spec.task.id);
  return { workspace, manifest: `${workspace}.json`, lock: `${workspace}.operation.lock` };
}

// No abandoned lock is automatically stolen. The caller must establish writer termination first.
export async function withLoopWorkspace<T>(
  statePath: string,
  root: string,
  action: (run: LoopRun, workspace: string, manifestPath: string) => Promise<T>,
): Promise<T> {
  const run = await readLoopRun(statePath);
  const p = await paths(root, run);
  const lock = await open(p.lock, "wx", 0o600);
  try {
    return await action(await readLoopRun(statePath), p.workspace, p.manifest);
  } finally {
    await lock.close();
    await rm(p.lock);
  }
}

export async function inspectLoopWorkspace(run: LoopRun, workspace: string, manifestPath: string) {
  if (
    (await lstat(workspace)).isSymbolicLink() ||
    (await realpath(workspace)) !== resolve(workspace)
  )
    throw new Error("workspace_path_changed");
  const owner = parseWorkspace(JSON.parse(await readFile(manifestPath, "utf8")));
  const checkout = readCheckout(workspace);
  if (
    owner.specDigest !== run.specDigest ||
    owner.branch !== `automation/loop/${run.spec.task.id}` ||
    checkout.branch !== owner.branch ||
    checkout.dirty
  )
    throw new Error("workspace_ownership_or_checkout_changed");
  const expected = owner.pending
    ? [owner.pending.baseSha, owner.pending.candidateSha]
    : [owner.headSha];
  if (!expected.includes(checkout.sourceSha)) throw new Error("workspace_head_changed");
  return { owner, checkout };
}

export async function prepareLoopWorkspace(statePath: string, source: string, root: string) {
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = assessLoopRun(run);
    if (!["ready", "running"].includes(view.phase))
      throw new Error(`loop_not_executable:${view.reason}`);
    const origin = loopGit(source, ["remote", "get-url", "origin"]);
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(origin);
    if (match?.[1] !== run.spec.repository) throw new Error("source_repository_mismatch");
    try {
      await lstat(workspace);
      const current = await inspectLoopWorkspace(run, workspace, manifest);
      if (current.owner.pending) throw new Error("interrupted_patch_needs_recovery");
      return { workspace, ...current };
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      // An existing worktree without a manifest is not adopted or reset.
      try {
        await lstat(workspace);
        throw new Error("unowned_workspace");
      } catch (missing) {
        if (!isRecord(missing) || missing.code !== "ENOENT") throw missing;
      }
    }
    loopGit(source, ["cat-file", "-e", `${run.spec.baselineSha}^{commit}`]);
    const branch = `automation/loop/${run.spec.task.id}`;
    loopGit(source, ["worktree", "add", "-b", branch, workspace, run.spec.baselineSha]);
    const owner = await updateJsonRevision(manifest, 0, parseWorkspace, () => ({
      revision: 1,
      specDigest: run.specDigest,
      branch,
      headSha: run.spec.baselineSha,
      iteration: 0,
      patchDigest: null,
      pending: null,
    }));
    return { workspace, owner, checkout: readCheckout(workspace) };
  });
}

export async function applyLoopPatch(
  statePath: string,
  root: string,
  iteration: number,
  baseSha: string,
  patch: string,
) {
  integer(iteration, "patch_iteration", 1);
  requireSha(baseSha);
  if (
    !patch.trim() ||
    Buffer.byteLength(patch) > 1_048_576 ||
    patch.includes("\0") ||
    patch.includes("GIT binary patch")
  )
    throw new Error("invalid_loop_patch");
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = assessLoopRun(run);
    if (view.phase !== "running" || view.activeAttempt?.number !== iteration)
      throw new Error("patch_has_no_matching_active_attempt");
    let { owner, checkout } = await inspectLoopWorkspace(run, workspace, manifest);
    const patchDigest = digest(patch);
    if (owner.iteration === iteration) {
      if (owner.patchDigest !== patchDigest) throw new Error("attempt_already_has_another_patch");
      if (!owner.pending) return { workspace, owner, checkout };
      if (owner.pending.baseSha !== baseSha) throw new Error("patch_base_mismatch");
      // Retry only the exact recorded transaction, against one of its two known clean heads.
    } else {
      if (owner.pending || owner.iteration > iteration || checkout.sourceSha !== baseSha)
        throw new Error("patch_base_or_transaction_mismatch");
      const index = `${manifest}.${randomUUID()}.index`;
      const env = { ...process.env, GIT_INDEX_FILE: index };
      let candidate: string;
      try {
        loopGit(workspace, ["read-tree", baseSha], { env });
        loopGit(workspace, ["apply", "--cached", "--check", "-"], { input: patch, env });
        loopGit(workspace, ["apply", "--cached", "-"], { input: patch, env });
        const tree = loopGit(workspace, ["write-tree"], { env });
        if (tree === loopGit(workspace, ["rev-parse", `${baseSha}^{tree}`]))
          throw new Error("empty_loop_patch");
        candidate = requireSha(
          loopGit(workspace, [
            "-c",
            "user.name=HiFiScout loop",
            "-c",
            "user.email=loop@hifiscout.invalid",
            "commit-tree",
            tree,
            "-p",
            baseSha,
            "-m",
            `fix(loop): ${run.spec.task.id} attempt ${iteration}`,
          ]),
        );
      } finally {
        await rm(index, { force: true });
      }
      const scope = {
        baselineSha: run.spec.baselineSha,
        sourceSha: candidate,
        artifactUri: `.generated/loop/attempt-${iteration}/scope.json`,
        changes: readLoopChanges(run.spec.baselineSha, candidate, workspace),
      };
      const assessment = assessLoopScope(run.spec, candidate, scope);
      if (assessment.status !== "pass") {
        await recordLoopEvent(statePath, run, "blocked", {
          reason: "change_scope_violation",
          scope,
        });
        throw new Error(`patch_rejected:${assessment.reason}`);
      }
      const latest = await readLoopRun(statePath);
      if (latest.revision !== run.revision || assessLoopRun(latest).phase !== "running")
        throw new Error("run_changed_during_patch");
      await inspectLoopWorkspace(run, workspace, manifest);
      owner = await updateJsonRevision(manifest, owner.revision, parseWorkspace, () => ({
        ...owner,
        revision: owner.revision + 1,
        iteration,
        patchDigest,
        pending: { baseSha, candidateSha: candidate },
      }));
    }
    const candidate = owner.pending!.candidateSha;
    if (assessLoopRun(await readLoopRun(statePath)).phase !== "running")
      throw new Error("run_no_longer_active");
    loopGit(workspace, ["reset", "--hard", candidate]);
    owner = await updateJsonRevision(manifest, owner.revision, parseWorkspace, () => ({
      ...owner,
      revision: owner.revision + 1,
      headSha: candidate,
      pending: null,
    }));
    checkout = readCheckout(workspace);
    return { workspace, owner, checkout };
  });
}

// GitHub connectors may create a different commit object for the same tree and parents.
// Bind that exact object BEFORE evaluation; never transfer a passing report to another SHA.
export async function adoptLoopCommit(
  statePath: string,
  root: string,
  localSha: string,
  remoteSha: string,
) {
  requireSha(localSha);
  requireSha(remoteSha);
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = assessLoopRun(run);
    if (view.phase !== "running" || !view.activeAttempt)
      throw new Error("adoption_requires_active_attempt");
    const iteration = view.activeAttempt.number;
    let { owner, checkout } = await inspectLoopWorkspace(run, workspace, manifest);
    if (owner.iteration !== iteration || !owner.patchDigest)
      throw new Error("adoption_requires_applied_patch");
    try {
      await lstat(resolve(workspace, `.generated/loop/attempt-${iteration}`));
      throw new Error("adoption_after_evaluation_started");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    const identity = (sha: string) => loopGit(workspace, ["show", "-s", "--format=%T %P", sha]);
    if (identity(localSha) !== identity(remoteSha))
      throw new Error("adoption_tree_or_parents_mismatch");
    if (owner.pending) {
      if (owner.pending.baseSha !== localSha || owner.pending.candidateSha !== remoteSha)
        throw new Error("adoption_transaction_mismatch");
    } else {
      if (checkout.sourceSha === remoteSha) return { workspace, owner, checkout };
      if (checkout.sourceSha !== localSha) throw new Error("adoption_local_head_mismatch");
      owner = await updateJsonRevision(manifest, owner.revision, parseWorkspace, () => ({
        ...owner,
        revision: owner.revision + 1,
        pending: { baseSha: localSha, candidateSha: remoteSha },
      }));
    }
    const latest = await readLoopRun(statePath);
    if (latest.revision !== run.revision || assessLoopRun(latest).phase !== "running")
      throw new Error("run_changed_during_adoption");
    loopGit(workspace, ["reset", "--hard", remoteSha]);
    owner = await updateJsonRevision(manifest, owner.revision, parseWorkspace, () => ({
      ...owner,
      revision: owner.revision + 1,
      headSha: remoteSha,
      pending: null,
    }));
    checkout = readCheckout(workspace);
    return { workspace, owner, checkout };
  });
}
