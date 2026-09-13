import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isRecord } from "../../src/types.js";
import {
  assessHarnessReport,
  bindRequiredChecks,
  parseHarnessReport,
  requireSha,
  requireText,
  requireTimestamp,
} from "./report.js";
import type { CheckScope, HarnessReport } from "./report.js";
import { updateJsonRevision } from "./store.js";

export interface HarnessTask {
  id: string;
  goal: string;
  requirements: { id: string; scope: CheckScope }[];
  constraints: string[];
  nextActions: string[];
}
export interface CheckoutState {
  sourceSha: string;
  branch: string;
  dirty: boolean;
}
interface Checkpoint {
  schemaVersion: 1;
  revision: number;
  task: HarnessTask;
  taskDigest: string;
  report: HarnessReport;
  checkout: CheckoutState;
  updatedAt: string;
}

export function parseHarnessTask(value: unknown): HarnessTask {
  if (
    !isRecord(value) ||
    !Array.isArray(value.requirements) ||
    !Array.isArray(value.constraints) ||
    !Array.isArray(value.nextActions)
  ) {
    throw new Error("invalid_harness_task");
  }
  const requirements = value.requirements.map((item): HarnessTask["requirements"][number] => {
    if (
      !isRecord(item) ||
      (item.scope !== "source" && item.scope !== "deployment" && item.scope !== "observation")
    )
      throw new Error("invalid_task_requirement");
    return { id: requireText(item.id, "requirement_id"), scope: item.scope };
  });
  if (!requirements.length || new Set(requirements.map((r) => r.id)).size !== requirements.length)
    throw new Error("empty_or_duplicate_requirements");
  return {
    id: requireText(value.id, "task_id"),
    goal: requireText(value.goal, "task_goal"),
    requirements,
    constraints: value.constraints.map((v) => requireText(v, "constraint")),
    nextActions: value.nextActions.map((v) => requireText(v, "next_action")),
  };
}

const taskDigest = (task: HarnessTask) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        id: task.id,
        goal: task.goal,
        requirements: task.requirements,
        constraints: task.constraints,
      }),
    )
    .digest("hex");

export function readCheckout(cwd = process.cwd()): CheckoutState {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
  return {
    sourceSha: requireSha(git(["rev-parse", "HEAD"])),
    branch: git(["branch", "--show-current"]) || "detached",
    dirty: git(["status", "--porcelain", "--untracked-files=normal"]) !== "",
  };
}

function parseCheckpoint(value: unknown): Checkpoint {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !isRecord(value.checkout) ||
    typeof value.checkout.dirty !== "boolean"
  )
    throw new Error("invalid_checkpoint");
  const task = parseHarnessTask(value.task);
  if (value.taskDigest !== taskDigest(task)) throw new Error("checkpoint_task_digest_mismatch");
  return {
    schemaVersion: 1,
    revision: Number(value.revision),
    task,
    taskDigest: value.taskDigest,
    report: parseHarnessReport(value.report),
    updatedAt: requireTimestamp(value.updatedAt),
    checkout: {
      sourceSha: requireSha(value.checkout.sourceSha),
      branch: requireText(value.checkout.branch, "branch"),
      dirty: value.checkout.dirty,
    },
  };
}

export function assessCheckpoint(value: unknown, current: CheckoutState) {
  const checkpoint = parseCheckpoint(value);
  const report = checkpoint.report;
  // The task owns acceptance requirements. A runner cannot waive one by changing required=false,
  // dropping a check, or relabeling a production observation as a source-only test.
  const checks = bindRequiredChecks(checkpoint.task.requirements, report.checks);
  const sourceStable =
    current.sourceSha === report.sourceSha &&
    checkpoint.checkout.sourceSha === report.sourceSha &&
    !current.dirty &&
    !checkpoint.checkout.dirty;
  for (const check of checks) {
    if (!sourceStable && (check.status === "pass" || check.status === "fail")) {
      check.status = "unknown";
      check.reason = "Checkout changed or contains uncommitted work; revalidate before completion";
    }
  }
  const assessed = assessHarnessReport({ ...report, checks });
  return {
    taskId: checkpoint.task.id,
    revision: checkpoint.revision,
    goal: checkpoint.task.goal,
    constraints: checkpoint.task.constraints,
    lastVerifiedSourceSha: report.sourceSha,
    checkout: current,
    checkoutMatchesEvidence: sourceStable,
    status: assessed.status,
    checks: assessed.checks,
    remaining: assessed.checks
      .filter((check) => check.required && check.status !== "pass")
      .map((check) => check.id),
    nextActions: checkpoint.task.nextActions,
  };
}

export async function saveCheckpoint(
  taskValue: unknown,
  reportValue: unknown,
  path: string,
  expectedRevision: number,
  checkout = readCheckout(),
) {
  const task = parseHarnessTask(taskValue);
  const report = parseHarnessReport(reportValue);
  const next = await updateJsonRevision(
    path,
    expectedRevision,
    parseCheckpoint,
    (previous): Checkpoint => {
      if (previous && previous.taskDigest !== taskDigest(task))
        throw new Error("task_scope_changed_use_a_new_checkpoint");
      return {
        schemaVersion: 1,
        revision: expectedRevision + 1,
        task,
        taskDigest: taskDigest(task),
        report,
        checkout,
        updatedAt: new Date().toISOString(),
      };
    },
  );
  return assessCheckpoint(next, checkout);
}
