import { isRecord } from "../../../src/types.js";
import { assessDelivery } from "../delivery.js";
import type { DeliverySnapshot } from "../delivery.js";
import {
  assessHarnessReport,
  bindRequiredChecks,
  requireSha,
  requireText,
  requireTimestamp,
} from "../report.js";
import { integer, isDeliveryCheck, relativePath } from "./contract.js";
import type { LoopSpec } from "./contract.js";

export interface LoopReviewReceipt {
  sourceSha: string;
  method: "codex" | "self";
  completedAt: string;
  summary: string;
  reviewedPaths: string[];
  unresolvedFindings: number;
  artifactUri: string;
}

export function parseLoopReview(value: unknown): LoopReviewReceipt {
  if (
    !isRecord(value) ||
    (value.method !== "codex" && value.method !== "self") ||
    !Array.isArray(value.reviewedPaths) ||
    value.reviewedPaths.length > 200
  )
    throw new Error("invalid_loop_review_receipt");
  const paths = value.reviewedPaths.map(relativePath);
  if (new Set(paths).size !== paths.length) throw new Error("duplicate_reviewed_path");
  return {
    sourceSha: requireSha(value.sourceSha),
    method: value.method,
    completedAt: requireTimestamp(value.completedAt),
    summary: requireText(value.summary, "review_summary"),
    reviewedPaths: paths,
    unresolvedFindings: integer(value.unresolvedFindings, "unresolved_findings"),
    artifactUri: relativePath(value.artifactUri),
  };
}

export function assessLoopDelivery(
  spec: LoopSpec,
  headSha: string,
  prNumber: number,
  value: unknown,
) {
  if (
    !isRecord(value) ||
    value.repository !== spec.repository ||
    !isRecord(value.pull) ||
    !isRecord(value.pull.head) ||
    !isRecord(value.pull.base) ||
    value.pull.head.sha !== headSha ||
    value.pull.number !== prNumber ||
    value.pull.base.ref !== "main" ||
    !isRecord(value.pullAfter) ||
    !Array.isArray(value.reviewPages) ||
    !Array.isArray(value.ciRuns) ||
    !Array.isArray(value.statuses) ||
    !Array.isArray(value.downstream)
  )
    throw new Error("loop_delivery_identity_mismatch");
  // assessDelivery validates the nested API responses and receipts before any status is accepted.
  const report = assessDelivery(value as unknown as DeliverySnapshot, spec.delivery.target);
  return assessHarnessReport({
    ...report,
    checks: bindRequiredChecks(
      spec.task.requirements.filter((r) => isDeliveryCheck(r.id) || r.scope !== "source"),
      report.checks,
    ),
  });
}
