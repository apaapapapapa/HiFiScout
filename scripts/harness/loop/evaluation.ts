import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "../../../src/types.js";
import { readCheckout } from "../checkpoint.js";
import { compareCosts, readCostSamples } from "../cost.js";
import { compareReplays } from "../replay.js";
import { assessHarnessReport, parseHarnessReport } from "../report.js";
import type { HarnessCheck, HarnessReport } from "../report.js";
import { assessLoopRun, finishLoopAttempt } from "./controller.js";
import { inspectLoopWorkspace, loopGit, withLoopWorkspace } from "./workspace.js";
import { collectLoopScope } from "./scope.js";
import { runLoopCommand } from "./command.js";
import type { LoopSpec } from "./contract.js";

type Invoke = typeof runLoopCommand;
interface Measurement {
  report: HarnessReport;
  replay: unknown;
  costs: unknown[];
}
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

async function measure(
  spec: LoopSpec,
  workspace: string,
  output: string,
  deadline: string,
  invoke: Invoke,
  ui: boolean,
  aiRecording?: string,
): Promise<Measurement> {
  const sourceSha = readCheckout(workspace).sourceSha,
    startedAt = new Date().toISOString();
  const directory = resolve(workspace, output);
  await mkdir(directory, { recursive: true });
  const checks: HarnessCheck[] = [];
  const execute = async (name: string, args: string[]) =>
    invoke({
      cwd: workspace,
      args,
      deadline,
      logPath: join(directory, `${name}.log`),
      costOutput: join(directory, "cost"),
    });
  const check = (
    id: string,
    status: HarnessCheck["status"],
    reason: string,
    artifact: string,
  ): HarnessCheck => ({
    id,
    status,
    reason,
    scope: "source",
    required: true,
    evidence: [{ uri: `${output}/${artifact}`, sourceSha }],
  });
  const install = await execute("install", ["install", "--frozen-lockfile"]);
  if (install.status !== "pass") {
    checks.push(check("source-checks", "unknown", "locked_dependency_setup_failed", "install.log"));
  } else {
    const source = await execute("source", ["run", "check"]);
    checks.push(check("source-checks", source.status, source.reason, "source.log"));
  }
  const collect = async (name: string, args: string[], file: string, ids: string[]) => {
    if (install.status !== "pass") {
      checks.push(
        ...ids.map((id) => check(id, "unknown", "dependency_setup_incomplete", "install.log")),
      );
      return;
    }
    const execution = await execute(name, ["run", "harness", ...args]);
    try {
      const report = assessHarnessReport(await json(join(directory, file)));
      if (
        report.sourceSha !== sourceSha ||
        report.startedAt < execution.startedAt ||
        report.finishedAt > execution.finishedAt ||
        execution.status === "unknown" ||
        (execution.status !== "pass" && report.status === "pass")
      )
        throw new Error("collector_identity_or_interval_mismatch");
      checks.push(...report.checks);
    } catch {
      checks.push(
        ...ids.map((id) =>
          check(id, "unknown", "missing_or_invalid_collector_evidence", `${name}.log`),
        ),
      );
    }
  };
  let replay: unknown = null,
    costs: unknown[] = [];
  if (spec.comparisons.includes("replay")) {
    await collect("replay", ["replay", `${output}/replay`], "replay/replay-report.json", [
      "replay/evidence",
    ]);
    try {
      replay = await json(join(directory, "replay/replay.json"));
    } catch {
      /* Missing remains unknown. */
    }
  }
  if (spec.comparisons.includes("cost")) {
    await collect(
      "cost",
      ["cost-report", `${output}/cost`, `${output}/cost-report.json`],
      "cost-report.json",
      ["cost/evidence"],
    );
    try {
      costs = await readCostSamples(join(directory, "cost"));
    } catch {
      /* Missing remains unknown. */
    }
  }
  if (ui)
    await collect("ui", ["ui", `${output}/ui`], "ui/ui-report.json", ["ui/components", "ui/admin"]);
  if (spec.kind === "ai") {
    if (aiRecording)
      await collect("ai", ["ai", resolve(aiRecording), `${output}/ai`], "ai/ai-report.json", [
        "ai/offline-holdout",
      ]);
    else
      checks.push(
        check(
          "ai/offline-holdout",
          "unknown",
          "source_bound_AI_recording_required; no provider calls performed",
          "source.log",
        ),
      );
  }
  const current = readCheckout(workspace);
  if (current.dirty || current.sourceSha !== sourceSha)
    for (const item of checks) {
      item.status = "unknown";
      item.reason = "checkout_changed_during_evaluation";
    }
  const report = parseHarnessReport({
    schemaVersion: 1,
    runId: `loop-measure-${sourceSha}`,
    sourceSha,
    baselineSha: null,
    deploymentSha: null,
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  });
  await writeFile(
    join(directory, "measurement.json"),
    JSON.stringify({ report, replay, costs }, null, 2),
    { flag: "wx" },
  );
  return { report, replay, costs };
}

export async function evaluateLoopAttempt(
  statePath: string,
  root: string,
  aiRecording?: string,
  invoke: Invoke = runLoopCommand,
) {
  return withLoopWorkspace(statePath, root, async (run, workspace, manifest) => {
    const view = assessLoopRun(run);
    if (view.phase !== "running" || !view.activeAttempt)
      throw new Error("evaluation_requires_active_attempt");
    const { owner } = await inspectLoopWorkspace(run, workspace, manifest);
    if (owner.pending) throw new Error("interrupted_patch_needs_recovery");
    const iteration = view.activeAttempt.number,
      output = `.generated/loop/attempt-${iteration}`;
    // A repeated evaluate cannot reuse a prior passing command or overwrite its evidence.
    await mkdir(resolve(workspace, ".generated/loop"), { recursive: true });
    await mkdir(resolve(workspace, output));
    let baseline: Measurement | null = null;
    if (run.spec.comparisons.length) {
      const baselinePath = `${workspace}.baseline.json`;
      try {
        const value = await json(baselinePath);
        if (
          !isRecord(value) ||
          value.specDigest !== run.specDigest ||
          !isRecord(value.measurement) ||
          !Array.isArray(value.measurement.costs)
        )
          throw new Error("invalid_frozen_baseline");
        baseline = {
          report: parseHarnessReport(value.measurement.report),
          replay: value.measurement.replay,
          costs: value.measurement.costs,
        };
        if (baseline.report.sourceSha !== run.spec.baselineSha)
          throw new Error("baseline_sha_mismatch");
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        const baselineWorkspace = `${workspace}.baseline-${iteration}`;
        loopGit(workspace, [
          "worktree",
          "add",
          "--detach",
          baselineWorkspace,
          run.spec.baselineSha,
        ]);
        baseline = await measure(
          run.spec,
          baselineWorkspace,
          ".generated/loop/baseline",
          view.deadline,
          invoke,
          false,
        );
        await writeFile(
          baselinePath,
          JSON.stringify({ specDigest: run.specDigest, measurement: baseline }, null, 2),
          { flag: "wx" },
        );
      }
      await writeFile(
        resolve(workspace, output, "baseline.json"),
        JSON.stringify(baseline, null, 2),
        { flag: "wx" },
      );
    }
    const scope = await collectLoopScope(run.spec, workspace, `${output}/scope.json`);
    const ui =
      scope.changes.some((item) => item.path.startsWith("frontend/")) ||
      run.spec.task.requirements.some((r) => r.id.startsWith("ui/"));
    const candidate = await measure(
      run.spec,
      workspace,
      output,
      view.deadline,
      invoke,
      ui,
      aiRecording,
    );
    for (const kind of run.spec.comparisons) {
      let comparison: {
        status: HarnessCheck["status"];
        sourceSha: string;
        baselineSha: string;
      } | null = null;
      try {
        comparison =
          kind === "replay"
            ? compareReplays(baseline?.replay, candidate.replay)
            : compareCosts(baseline?.costs ?? [], candidate.costs);
      } catch {
        /* Incomplete baseline/candidate evidence cannot pass. */
      }
      const bound =
        comparison?.sourceSha === candidate.report.sourceSha &&
        comparison.baselineSha === run.spec.baselineSha;
      await writeFile(
        resolve(workspace, output, `comparison-${kind}.json`),
        JSON.stringify(comparison, null, 2),
        { flag: "wx" },
      );
      candidate.report.checks.push({
        id: `comparison:${kind}`,
        scope: "source",
        required: true,
        status: bound ? comparison!.status : "unknown",
        reason: bound
          ? "frozen_baseline_comparison; inspect measurements"
          : "missing_or_mismatched_comparison",
        evidence: [
          { uri: `${output}/comparison-${kind}.json`, sourceSha: candidate.report.sourceSha },
        ],
      });
    }
    const report = {
      ...candidate.report,
      baselineSha: run.spec.baselineSha,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(resolve(workspace, output, "report.json"), JSON.stringify(report, null, 2), {
      flag: "wx",
    });
    return finishLoopAttempt(
      statePath,
      report,
      readCheckout(workspace),
      new Date().toISOString(),
      scope,
    );
  });
}
