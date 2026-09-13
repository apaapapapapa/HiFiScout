import type { AiAdminCommand, AiJobStatus, AiReviewOutcome } from "../api/admin-ai-contracts.js";
import { isRecord } from "../types.js";

const jobId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const timestamp = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) &&
  Number.isFinite(Date.parse(v));
const statuses = new Set<AiJobStatus>([
  "queued",
  "processing",
  "suggested",
  "no_suggestion",
  "invalid",
  "deferred",
  "stale",
  "failed",
  "reviewed",
]);
export function parseAiAdminCommand(value: unknown): AiAdminCommand | null {
  if (!isRecord(value)) return null;
  if (value.action === "block") return { action: "block" };
  if (value.action === "list") {
    if (!statuses.has(value.status as AiJobStatus)) return null;
    const cursor = value.before;
    if (cursor == null)
      return { action: "list", status: value.status as AiJobStatus, before: null };
    if (!isRecord(cursor) || !timestamp(cursor.updatedAt) || !jobId(cursor.id)) return null;
    return {
      action: "list",
      status: value.status as AiJobStatus,
      before: { updatedAt: cursor.updatedAt, id: cursor.id },
    };
  }
  if (
    value.action === "prepare" &&
    Number.isSafeInteger(value.candidateId) &&
    Number(value.candidateId) > 0
  )
    return { action: "prepare", candidateId: Number(value.candidateId) };
  if ((value.action === "detail" || value.action === "retry") && jobId(value.id))
    return { action: value.action, id: value.id };
  if (
    value.action === "review" &&
    jobId(value.id) &&
    ["useful", "incorrect", "insufficient_evidence"].includes(String(value.outcome))
  )
    return { action: "review", id: value.id, outcome: value.outcome as AiReviewOutcome };
  if (
    value.action === "grant" &&
    Number.isSafeInteger(value.allowanceNeurons) &&
    Number(value.allowanceNeurons) > 0 &&
    Number(value.allowanceNeurons) <= 1000 &&
    typeof value.evidence === "string" &&
    value.evidence.trim().length > 0 &&
    value.evidence.length <= 900 &&
    timestamp(value.checkedAt) &&
    value.otherConsumersAccountedFor === true
  )
    return {
      action: "grant",
      allowanceNeurons: Number(value.allowanceNeurons),
      evidence: value.evidence.trim(),
      checkedAt: value.checkedAt,
      otherConsumersAccountedFor: true,
    };
  return null;
}
