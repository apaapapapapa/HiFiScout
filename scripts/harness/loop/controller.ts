import { isRecord } from "../../../src/types.js";
import type { CheckoutState } from "../checkpoint.js";
import {
  assessHarnessReport,
  bindRequiredChecks,
  parseHarnessReport,
  requireSha,
  requireText,
  requireTimestamp,
} from "../report.js";
import type { HarnessCheck, HarnessReport } from "../report.js";
import { digest, integer, isDeliveryCheck } from "./contract.js";
import type { LoopSpec } from "./contract.js";
import { appendLoopEvent, parseLoopRun, readLoopRun } from "./state.js";
import type { LoopRun } from "./state.js";
import { assessLoopScope } from "./scope.js";

export type LoopPhase =
  | "ready"
  | "running"
  | "review"
  | "delivery"
  | "completed"
  | "blocked"
  | "stopped";
export interface LoopView {
  taskId: string;
  revision: number;
  phase: LoopPhase;
  reason: string;
  attempts: number;
  noProgress: number;
  externalCalls: number;
  reservedCostMicros: number;
  deadline: string;
  lastProgressAt: string;
  activeAttempt: { number: number; startedAt: string; hypothesis: string } | null;
  lastReport: HarnessReport | null;
  lastVerifiedSha: string | null;
  nextAction: string;
}

export function assessLoopSource(
  spec: LoopSpec,
  value: unknown,
  checkout: CheckoutState,
  scope: unknown = null,
) {
  const report = parseHarnessReport(value);
  const requirements = [
    ...spec.task.requirements.filter((r) => r.scope === "source" && !isDeliveryCheck(r.id)),
    ...spec.comparisons.map((kind) => ({ id: `comparison:${kind}`, scope: "source" as const })),
  ];
  const checks = bindRequiredChecks(
    requirements,
    report.checks.filter((c) => c.scope === "source" && !isDeliveryCheck(c.id)),
  );
  const put = (check: HarnessCheck) => {
    const index = checks.findIndex((item) => item.id === check.id);
    if (index < 0) checks.push(check);
    else checks[index] = check;
  };
  put(assessLoopScope(spec, report.sourceSha, scope));
  if (spec.comparisons.length && report.baselineSha !== spec.baselineSha)
    put({
      id: "loop:baseline",
      required: true,
      scope: "source",
      status: "unknown",
      reason: "Comparison baseline differs from the frozen contract",
      evidence: [],
    });
  if (checkout.dirty || requireSha(checkout.sourceSha) !== report.sourceSha) {
    for (const check of checks) {
      check.status = "unknown";
      check.reason = "Checkout changed; revalidate before using this outcome";
    }
    put({
      id: "loop:checkout",
      scope: "source",
      required: true,
      status: "unknown",
      reason: "Checkout does not match the recorded evidence",
      evidence: [],
    });
  }
  return assessHarnessReport({ ...report, checks });
}

function parseCheckout(value: unknown): CheckoutState {
  if (!isRecord(value) || typeof value.dirty !== "boolean")
    throw new Error("invalid_loop_checkout");
  return {
    sourceSha: requireSha(value.sourceSha),
    branch: requireText(value.branch, "branch"),
    dirty: value.dirty,
  };
}

function ensure(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`invalid_loop_transition:${reason}`);
}

export function assessLoopRun(value: unknown, now = new Date().toISOString()): LoopView {
  const run = parseLoopRun(value);
  const at = requireTimestamp(now);
  if (at < run.updatedAt) throw new Error("loop_clock_before_history");
  const deadline = new Date(
    Date.parse(run.startedAt) + run.spec.budget.maxDurationMs,
  ).toISOString();
  const view: LoopView = {
    taskId: run.spec.task.id,
    revision: run.revision,
    phase: "ready",
    reason: "ready",
    attempts: 0,
    noProgress: 0,
    externalCalls: 0,
    reservedCostMicros: 0,
    deadline,
    lastProgressAt: run.startedAt,
    activeAttempt: null,
    lastReport: null,
    lastVerifiedSha: null,
    nextAction: "start-attempt",
  };
  let bestPassed = -1;
  let previousFailure: string | null = null;
  for (const event of run.events.slice(1)) {
    ensure(view.phase !== "stopped" && view.phase !== "completed", "terminal_run");
    const data = event.data;
    switch (event.type) {
      case "attempt-started": {
        ensure(view.phase === "ready" && !view.activeAttempt, "attempt_already_active");
        ensure(
          event.at < deadline &&
            view.attempts < run.spec.budget.maxIterations &&
            view.noProgress < run.spec.budget.maxNoProgress,
          "budget_exhausted",
        );
        ensure(integer(data.iteration, "iteration", 1) === view.attempts + 1, "iteration_sequence");
        view.externalCalls += integer(data.externalCalls, "external_calls");
        view.reservedCostMicros += integer(data.reservedCostMicros, "reserved_cost");
        ensure(
          Number.isSafeInteger(view.reservedCostMicros) &&
            view.externalCalls <= run.spec.budget.maxExternalCalls &&
            view.reservedCostMicros <= run.spec.budget.maxReservedCostMicros,
          "reservation_exceeds_budget",
        );
        view.attempts++;
        view.activeAttempt = {
          number: view.attempts,
          startedAt: event.at,
          hypothesis: requireText(data.hypothesis, "hypothesis"),
        };
        view.phase = "running";
        view.reason = "attempt_in_progress";
        view.lastVerifiedSha = null;
        view.lastProgressAt = event.at;
        break;
      }
      case "attempt-finished": {
        ensure(view.phase === "running" && view.activeAttempt, "no_active_attempt");
        const report = parseHarnessReport(data.report);
        ensure(
          report.startedAt >= view.activeAttempt.startedAt && report.finishedAt <= event.at,
          "report_outside_attempt",
        );
        const result = assessLoopSource(run.spec, report, parseCheckout(data.checkout), data.scope);
        view.lastReport = result;
        view.activeAttempt = null;
        view.lastProgressAt = event.at;
        if (result.status === "pass") {
          view.lastVerifiedSha = result.sourceSha;
          view.phase = "review";
          view.reason = "source_verified";
        } else if (
          result.status === "unknown" ||
          result.checks.some(
            (check) => check.id === "loop:change-scope" && check.status !== "pass",
          ) ||
          result.checks.some(
            (check) => check.required && (check.status === "unknown" || check.status === "skipped"),
          )
        ) {
          view.phase = "blocked";
          view.reason = result.checks.some(
            (check) => check.id === "loop:change-scope" && check.status === "fail",
          )
            ? "change_scope_violation"
            : "incomplete_source_evidence";
        } else {
          const required = result.checks.filter((c) => c.required);
          const passed = required.filter((c) => c.status === "pass").length;
          const fingerprint = digest(
            required
              .filter((c) => c.status !== "pass")
              .map((c) => [c.id, c.status])
              .sort(),
          );
          view.noProgress =
            previousFailure === fingerprint || passed <= bestPassed ? view.noProgress + 1 : 0;
          bestPassed = Math.max(bestPassed, passed);
          previousFailure = fingerprint;
          view.phase = "ready";
          view.reason = "source_failed";
        }
        break;
      }
      case "blocked":
        view.phase = "blocked";
        view.reason = requireText(data.reason, "block_reason");
        break;
      case "resumed":
        ensure(view.phase === "blocked", "only_blocked_runs_resume");
        // An interrupted attempt keeps its reservation and iteration charge. Revalidate all evidence.
        view.activeAttempt = null;
        view.lastVerifiedSha = null;
        view.phase = "ready";
        view.reason = requireText(data.reason, "resume_reason");
        break;
      case "stopped":
        view.phase = "stopped";
        view.reason = requireText(data.reason, "stop_reason");
        break;
      case "heartbeat":
        // A heartbeat is liveness, not proof that work progressed.
        break;
      default:
        throw new Error(`unsupported_loop_event:${event.type}`);
    }
  }
  if (view.phase !== "stopped" && view.phase !== "completed") {
    const reason =
      at >= deadline
        ? "time_budget_exhausted"
        : view.phase === "ready" && view.attempts >= run.spec.budget.maxIterations
          ? "iteration_budget_exhausted"
          : view.phase === "ready" && view.noProgress >= run.spec.budget.maxNoProgress
            ? "no_progress_limit"
            : null;
    if (reason) {
      view.phase = "stopped";
      view.reason = reason;
    }
  }
  view.nextAction =
    view.phase === "ready"
      ? "start-attempt"
      : view.phase === "running"
        ? "await-attempt"
        : view.phase === "review"
          ? "request-review"
          : view.phase === "blocked"
            ? "resolve-blocker"
            : "none";
  return view;
}

export async function recordLoopEvent(
  path: string,
  run: LoopRun,
  type: Parameters<typeof appendLoopEvent>[3],
  data: Record<string, unknown>,
  at = new Date().toISOString(),
): Promise<LoopView> {
  // Validate the prospective event before writing. The journal still fences concurrent writers.
  const { digest: previousDigest } = run.events.at(-1)!;
  const fields = {
    sequence: run.revision + 1,
    at: requireTimestamp(at),
    type,
    data,
    previousDigest,
  };
  const prospective = {
    ...run,
    revision: fields.sequence,
    updatedAt: fields.at,
    events: [...run.events, { ...fields, digest: digest(fields) }],
  };
  assessLoopRun(prospective, at);
  return assessLoopRun(
    await appendLoopEvent(path, run.revision, run.specDigest, type, data, at),
    at,
  );
}

export async function beginLoopAttempt(
  path: string,
  hypothesis: string,
  reservation: { externalCalls: number; reservedCostMicros: number },
  at = new Date().toISOString(),
): Promise<LoopView> {
  const run = await readLoopRun(path);
  const view = assessLoopRun(run, at);
  ensure(view.phase === "ready", view.reason);
  return recordLoopEvent(
    path,
    run,
    "attempt-started",
    { iteration: view.attempts + 1, hypothesis, ...reservation },
    at,
  );
}

export async function finishLoopAttempt(
  path: string,
  report: unknown,
  checkout: CheckoutState,
  at = new Date().toISOString(),
  scope: unknown = null,
): Promise<LoopView> {
  return recordLoopEvent(
    path,
    await readLoopRun(path),
    "attempt-finished",
    { report, checkout, scope },
    at,
  );
}
