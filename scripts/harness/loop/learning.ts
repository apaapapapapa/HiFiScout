import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../../../src/types.js";
import { readCheckout } from "../checkpoint.js";
import { requireSha, requireText, requireTimestamp } from "../report.js";
import { updateJsonRevision } from "../store.js";
import { digest, integer, relativePath } from "./contract.js";
import { assessLoopRun } from "./controller.js";
import { runLoopCommand } from "./command.js";
import { inspectLoopWorkspace, loopGit, withLoopWorkspace } from "./workspace.js";
import { readLoopChanges } from "./scope.js";

export interface LearningProposal {
  id: string;
  title: string;
  testPath: string;
  assertionName: string;
  sourceUrls: string[];
  labelReviewNotes: string | null;
  procedure: string[];
}
export function parseLearningProposal(value: unknown): LearningProposal {
  if (
    !isRecord(value) ||
    !Array.isArray(value.sourceUrls) ||
    value.sourceUrls.length < 1 ||
    value.sourceUrls.length > 10 ||
    !Array.isArray(value.procedure) ||
    value.procedure.length < 1 ||
    value.procedure.length > 12
  )
    throw new Error("invalid_learning_proposal");
  const id = requireText(value.id, "learning_id"),
    testPath = relativePath(value.testPath);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(id) || !/^test\/[\w/-]+\.test\.ts$/u.test(testPath))
    throw new Error("invalid_regression_identity");
  const text = (value: unknown) => {
    const result = requireText(value, "learning_text");
    if (result.length > 4000) throw new Error("learning_text_too_large");
    return result;
  };
  const sourceUrls = value.sourceUrls.map((value) => {
    const url = new URL(text(value));
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("invalid_learning_source_url");
    return url.toString();
  });
  return {
    id,
    testPath,
    title: text(value.title),
    assertionName: text(value.assertionName),
    sourceUrls,
    labelReviewNotes: value.labelReviewNotes == null ? null : text(value.labelReviewNotes),
    procedure: value.procedure.map(text),
  };
}

function assertionOutcome(value: unknown, proposal: LearningProposal): "pass" | "fail" | "unknown" {
  if (!isRecord(value) || !Array.isArray(value.testResults)) return "unknown";
  const suites = value.testResults.filter(
    (s) =>
      isRecord(s) &&
      typeof s.name === "string" &&
      (s.name === proposal.testPath ||
        s.name.replaceAll("\\", "/").endsWith(`/${proposal.testPath}`)),
  );
  if (suites.length !== 1 || !isRecord(suites[0]) || !Array.isArray(suites[0].assertionResults))
    return "unknown";
  const suite = suites[0],
    assertions = (suite.assertionResults as unknown[]).filter(
      (a) => isRecord(a) && a.fullName === proposal.assertionName,
    );
  if (assertions.length !== 1 || !isRecord(assertions[0])) return "unknown";
  const assertion = assertions[0];
  if (value.success === true && suite.status === "passed" && assertion.status === "passed")
    return "pass";
  if (
    value.success === false &&
    suite.status === "failed" &&
    assertion.status === "failed" &&
    Array.isArray(assertion.failureMessages) &&
    assertion.failureMessages.some((m) => typeof m === "string" && m.length > 0)
  )
    return "fail";
  return "unknown";
}
const json = async (path: string): Promise<unknown> => {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 2_097_152) throw new Error("regression_artifact_too_large");
  return JSON.parse(text);
};

export async function proveLoopRegression(
  statePath: string,
  root: string,
  value: unknown,
  invoke = runLoopCommand,
) {
  const proposal = parseLearningProposal(value);
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = assessLoopRun(run),
      { checkout, owner } = await inspectLoopWorkspace(run, workspace, manifest);
    if (
      !["review", "delivery", "completed"].includes(view.phase) ||
      checkout.sourceSha !== view.lastVerifiedSha ||
      owner.pending ||
      Date.now() >= Date.parse(view.deadline)
    )
      throw new Error("regression_requires_verified_source_and_remaining_time");
    const change = readLoopChanges(run.spec.baselineSha, checkout.sourceSha, workspace).find(
      (c) => c.path === proposal.testPath,
    );
    if (change?.status !== "A" || change.newMode !== "100644")
      throw new Error("regression_test_must_be_new_regular_source");
    if (["product", "ai"].includes(run.spec.kind) && !proposal.labelReviewNotes)
      throw new Error("label_source_review_notes_required");
    const code = execFileSync("git", ["show", `${checkout.sourceSha}:${proposal.testPath}`], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_048_576,
    });
    const uri = `.generated/loop/learning/${proposal.id}`,
      output = resolve(workspace, uri);
    await mkdir(dirname(output), { recursive: true });
    await mkdir(output);
    const baseline = `${workspace}.regression-${proposal.id}`;
    loopGit(workspace, ["worktree", "add", "--detach", baseline, run.spec.baselineSha]);
    await mkdir(dirname(join(baseline, proposal.testPath)), { recursive: true });
    await writeFile(join(baseline, proposal.testPath), code, { flag: "wx" });
    const baselineOutput = resolve(baseline, uri);
    await mkdir(baselineOutput, { recursive: true });
    const setup = await invoke({
      cwd: baseline,
      args: ["install", "--frozen-lockfile"],
      logPath: join(output, "baseline-install.log"),
      deadline: view.deadline,
    });
    if (setup.status !== "pass") throw new Error("regression_baseline_setup_incomplete");
    const startedAt = new Date().toISOString();
    const outcomes = [];
    for (const [name, cwd, directory] of [
      ["baseline", baseline, baselineOutput],
      ["candidate", workspace, output],
    ]) {
      const reportPath = join(directory, `${name}-vitest.json`);
      const execution = await invoke({
        cwd,
        args: ["test", "run", proposal.testPath, "--reporter=json", `--outputFile=${reportPath}`],
        logPath: join(output, `${name}.log`),
        deadline: view.deadline,
      });
      const report = await json(reportPath);
      if (name === "baseline")
        await writeFile(join(output, "baseline-vitest.json"), JSON.stringify(report, null, 2), {
          flag: "wx",
        });
      outcomes.push({
        name,
        execution,
        reportHash: digest(report),
        status:
          execution.status === (name === "baseline" ? "fail" : "pass")
            ? assertionOutcome(report, proposal)
            : "unknown",
      });
    }
    const extra = loopGit(baseline, ["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean);
    if (
      readCheckout(workspace).sourceSha !== checkout.sourceSha ||
      readCheckout(workspace).dirty ||
      loopGit(baseline, ["rev-parse", "HEAD"]) !== run.spec.baselineSha ||
      loopGit(baseline, ["diff", "--name-only", "HEAD"]) ||
      extra.length !== 1 ||
      extra[0] !== proposal.testPath ||
      (await readFile(join(baseline, proposal.testPath), "utf8")) !== code
    )
      throw new Error("regression_source_or_test_changed");
    if (outcomes[0].status !== "fail" || outcomes[1].status !== "pass")
      throw new Error("regression_not_reproduced_and_fixed");
    if (Date.now() >= Date.parse(view.deadline)) throw new Error("regression_deadline_exceeded");
    const proof = {
      schemaVersion: 1 as const,
      specDigest: run.specDigest,
      proposalDigest: digest(proposal),
      baselineSha: run.spec.baselineSha,
      sourceSha: checkout.sourceSha,
      testDigest: digest(code),
      startedAt,
      finishedAt: new Date().toISOString(),
      outcomes,
    };
    await writeFile(join(output, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
    return { proposal, proof, artifactUri: `${uri}/proof.json` };
  });
}

interface LearningIndex {
  schemaVersion: 1;
  revision: number;
  cases: { id: string; record: Record<string, unknown> }[];
}
function parseIndex(value: unknown): LearningIndex {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.cases) ||
    value.cases.length > 1000
  )
    throw new Error("invalid_learning_index");
  const cases = value.cases.map((item) => {
    if (
      !isRecord(item) ||
      !isRecord(item.record) ||
      item.record.pool !== "regression-only" ||
      item.record.independentLabelReview !== "not-recorded" ||
      item.record.procedureAuthority !== "reference-data-only"
    )
      throw new Error("invalid_learning_record");
    return { id: requireText(item.id, "learning_key"), record: item.record };
  });
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("duplicate_learning_key");
  const result: LearningIndex = {
    schemaVersion: 1,
    revision: integer(value.revision, "learning_revision", 1),
    cases,
  };
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) + 1 > 2_097_152)
    throw new Error("learning_index_capacity_reached");
  return result;
}

export async function learnFromLoop(
  statePath: string,
  root: string,
  value: unknown,
  indexPath: string,
) {
  const proposal = parseLearningProposal(value);
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = assessLoopRun(run),
      { checkout } = await inspectLoopWorkspace(run, workspace, manifest);
    if (
      view.phase !== "completed" ||
      checkout.sourceSha !== view.lastVerifiedSha ||
      !view.review ||
      !view.reviewReceipt
    )
      throw new Error("learning_requires_completed_verified_delivery");
    const uri = `.generated/loop/learning/${proposal.id}`,
      output = resolve(workspace, uri),
      proof = await json(join(output, "proof.json"));
    if (
      !isRecord(proof) ||
      proof.specDigest !== run.specDigest ||
      proof.proposalDigest !== digest(proposal) ||
      proof.baselineSha !== run.spec.baselineSha ||
      proof.sourceSha !== checkout.sourceSha ||
      !Array.isArray(proof.outcomes) ||
      proof.outcomes.length !== 2
    )
      throw new Error("learning_proof_identity_mismatch");
    requireSha(proof.sourceSha);
    requireTimestamp(proof.startedAt);
    requireTimestamp(proof.finishedAt);
    for (const [i, name] of ["baseline", "candidate"].entries()) {
      const report = await json(join(output, `${name}-vitest.json`)),
        outcome = proof.outcomes[i];
      if (
        !isRecord(outcome) ||
        outcome.reportHash !== digest(report) ||
        outcome.name !== name ||
        !isRecord(outcome.execution) ||
        outcome.execution.status !== (i === 0 ? "fail" : "pass") ||
        outcome.status !== (i === 0 ? "fail" : "pass") ||
        assertionOutcome(report, proposal) !== (i === 0 ? "fail" : "pass")
      )
        throw new Error("learning_report_changed_or_incomplete");
    }
    const code = execFileSync("git", ["show", `${checkout.sourceSha}:${proposal.testPath}`], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_048_576,
    });
    if (digest(code) !== proof.testDigest) throw new Error("learning_test_changed");
    const id = digest([run.spec.repository, run.spec.task.id, proposal.id, checkout.sourceSha]);
    const record = {
      proposal,
      repository: run.spec.repository,
      taskId: run.spec.task.id,
      kind: run.spec.kind,
      baselineSha: run.spec.baselineSha,
      sourceSha: checkout.sourceSha,
      deliveredSha: view.lastDeliveryReport?.sourceSha,
      pullUrl: `https://github.com/${run.spec.repository}/pull/${view.review.prNumber}`,
      proofUri: `${uri}/proof.json`,
      pool: "regression-only",
      independentLabelReview: "not-recorded",
      procedureAuthority: "reference-data-only",
    };
    let previous: LearningIndex | null = null;
    try {
      previous = parseIndex(await json(indexPath));
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    const existing = previous?.cases.find((c) => c.id === id);
    if (existing) {
      if (digest(existing.record) !== digest(record)) throw new Error("learning_identity_conflict");
      return existing;
    }
    await updateJsonRevision(indexPath, previous?.revision ?? 0, parseIndex, (prior) => ({
      schemaVersion: 1 as const,
      revision: (prior?.revision ?? 0) + 1,
      cases: [...(prior?.cases ?? []), { id, record }],
    }));
    return { id, record };
  });
}
