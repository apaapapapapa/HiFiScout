import { createHash } from "node:crypto";
import { isRecord } from "../../../src/types.js";
import { parseHarnessTask } from "../checkpoint.js";
import type { HarnessTask } from "../checkpoint.js";
import { requireSha, requireText } from "../report.js";
import type { CheckScope } from "../report.js";

export const loopKinds = ["ci", "product", "cost", "ai"] as const;
export type LoopKind = (typeof loopKinds)[number];
export interface LoopSpec {
  schemaVersion: 1;
  kind: LoopKind;
  repository: string;
  baselineSha: string;
  task: HarnessTask;
  allowedPaths: string[];
  comparisons: ("replay" | "cost")[];
  budget: {
    maxIterations: number;
    maxDurationMs: number;
    maxNoProgress: number;
    maxExternalCalls: number;
    maxReservedCostMicros: number;
  };
  delivery: {
    target: "pr" | "merge" | "deployment";
    review: "self" | "optional" | "required";
    reviewWaitMs: number;
  };
}

const deliveryIds = new Set([
  "ci",
  "review-threads",
  "snapshot-stable",
  "main-merge",
  "review-approval",
  "deployment",
  "deployment/catalog-admin",
  "verification/e2e",
]);
export const isDeliveryCheck = (id: string): boolean => deliveryIds.has(id);

export function deliveryRequirements(
  policy: LoopSpec["delivery"],
): { id: string; scope: CheckScope }[] {
  const checks: { id: string; scope: CheckScope }[] = [
    "ci",
    "review-threads",
    "snapshot-stable",
  ].map((id) => ({ id, scope: "source" }));
  if (policy.review === "required") checks.push({ id: "review-approval", scope: "source" });
  if (policy.target !== "pr") checks.push({ id: "main-merge", scope: "source" });
  if (policy.target === "deployment")
    for (const id of ["deployment", "deployment/catalog-admin", "verification/e2e"])
      checks.push({ id, scope: "deployment" });
  return checks;
}

export function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`invalid_${label}`);
  return value;
}

export function relativePath(value: unknown): string {
  const path = requireText(value, "loop_path");
  if (!/^[\w.-][\w./-]*$/u.test(path) || path.split("/").some((p) => !p || p === "." || p === ".."))
    throw new Error("invalid_loop_path");
  return path;
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseLoopSpec(value: unknown): LoopSpec {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.budget) ||
    !isRecord(value.delivery) ||
    !Array.isArray(value.allowedPaths) ||
    !Array.isArray(value.comparisons)
  )
    throw new Error("invalid_loop_spec");
  if (!loopKinds.some((kind) => kind === value.kind)) throw new Error("invalid_loop_kind");
  const repository = requireText(value.repository, "loop_repository");
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("invalid_loop_repository");
  const task = parseHarnessTask(value.task);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(task.id)) throw new Error("invalid_loop_task_id");
  if (!task.requirements.some((r) => r.scope === "source" && !isDeliveryCheck(r.id)))
    throw new Error("loop_needs_source_gate");
  const allowedPaths = [...new Set(value.allowedPaths.map(relativePath))].sort();
  if (!allowedPaths.length) throw new Error("loop_needs_change_scope");
  const comparisons = value.comparisons.map((item) => {
    if (item !== "replay" && item !== "cost") throw new Error("invalid_loop_comparison");
    return item;
  });
  if (
    (value.kind === "product" && !comparisons.includes("replay")) ||
    (value.kind === "cost" && !comparisons.includes("cost"))
  )
    throw new Error("loop_kind_requires_comparison");
  const { target, review } = value.delivery;
  if (target !== "pr" && target !== "merge" && target !== "deployment")
    throw new Error("invalid_loop_target");
  if (review !== "self" && review !== "optional" && review !== "required")
    throw new Error("invalid_loop_review");
  const delivery = {
    target,
    review,
    reviewWaitMs: integer(value.delivery.reviewWaitMs, "review_wait", 1, 86_400_000),
  } as LoopSpec["delivery"];
  // Materialize mandatory milestones in the frozen task so checkpoint/resume cannot omit them.
  const mandatory = deliveryRequirements(delivery);
  if (value.kind === "ai") mandatory.push({ id: "ai:holdout", scope: "source" });
  for (const requirement of mandatory) {
    const existing = task.requirements.find((r) => r.id === requirement.id);
    if (existing && existing.scope !== requirement.scope)
      throw new Error("invalid_loop_gate_scope");
    if (!existing) task.requirements.push(requirement);
  }
  return {
    schemaVersion: 1,
    kind: value.kind as LoopKind,
    repository,
    baselineSha: requireSha(value.baselineSha),
    task,
    allowedPaths,
    comparisons: [...new Set(comparisons)].sort(),
    budget: {
      maxIterations: integer(value.budget.maxIterations, "max_iterations", 1, 20),
      maxDurationMs: integer(value.budget.maxDurationMs, "max_duration", 1, 86_400_000),
      maxNoProgress: integer(value.budget.maxNoProgress, "max_no_progress", 1, 20),
      maxExternalCalls: integer(value.budget.maxExternalCalls, "max_external_calls", 0, 100),
      maxReservedCostMicros: integer(value.budget.maxReservedCostMicros, "max_reserved_cost"),
    },
    delivery,
  };
}

export function loopSpecDigest(value: unknown): string {
  return digest(parseLoopSpec(value));
}

// An automated repair may not rewrite the controller, its acceptance machinery or agent authority.
// Changes to these paths are separate, deliberately reviewed engineering tasks.
const protectedPaths = [
  ".git",
  ".github",
  ".agents",
  ".codex",
  ".dependency-cruiser.json",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
  "scripts",
  "src/types.ts",
  "test/harness",
  "test/loop",
  "evaluations",
  "migrations",
  "wrangler.jsonc",
  "wrangler.admin.jsonc",
];

export function pathAllowed(spec: LoopSpec, value: unknown): boolean {
  const path = relativePath(value);
  if (
    path
      .split("/")
      .some((part) =>
        [
          "AGENTS.md",
          "CLAUDE.md",
          "SKILL.md",
          ".git",
          ".github",
          ".agents",
          ".codex",
          ".gitattributes",
          ".gitmodules",
          ".npmrc",
          "package.json",
          "package-lock.json",
          "tsconfig.json",
        ].includes(part),
      )
  )
    return false;
  if (
    protectedPaths.some(
      (prefix) =>
        path === prefix ||
        path.startsWith(`${prefix}/`) ||
        ((prefix === "test/harness" || prefix === "test/loop") && path.startsWith(`${prefix}-`)),
    )
  )
    return false;
  return spec.allowedPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
