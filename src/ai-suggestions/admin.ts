import type {
  AiAdminCommand,
  AiCatalogDetail,
  AiCatalogPage,
  AiJobSummary,
} from "../api/admin-ai-contracts.js";
import { parseAiAdminCommand } from "../http/admin-ai-catalog.js";
import {
  blockAiBudget,
  grantAiBudget,
  loadAiBudget,
  loadAiJob,
} from "../db/ai-catalog-repository.js";
import {
  aiCatalogEnabled,
  freshAiSnapshot,
  prepareAiCatalogJob,
  recordAiCatalogReview,
  retryAiCatalogJob,
} from "./service.js";
import { parseAiSnapshot, validateAiSuggestion } from "./contract.js";
import { AI_CATALOG_POLICY, AI_CATALOG_POLICY_KEY, aiBudgetDay } from "./policy.js";
import type { AiCatalogEnv, AiJobRow } from "./types.js";

function snapshot(job: AiJobRow) {
  try {
    return parseAiSnapshot(JSON.parse(job.snapshot_json));
  } catch {
    return null;
  }
}
function summary(job: AiJobRow): AiJobSummary {
  const input = snapshot(job);
  return {
    id: job.id,
    candidateId: job.candidate_id,
    status: job.status,
    attempts: job.attempts,
    title: input?.target.title || "",
    model: input?.target.model || "",
    manufacturerId: input?.target.manufacturerId || "",
    updatedAt: job.updated_at,
    error: job.error_code,
    reviewOutcome: job.review_outcome,
  };
}
async function page(
  env: AiCatalogEnv,
  command: Extract<AiAdminCommand, { action: "list" }>,
  now: Date,
): Promise<AiCatalogPage> {
  const budget = await loadAiBudget(env.DB, aiBudgetDay(now));
  const rows = await env.DB.prepare(`SELECT * FROM ai_catalog_jobs WHERE status = ?
    ${command.before ? "AND (updated_at,id) < (?,?)" : ""} ORDER BY updated_at DESC,id DESC LIMIT 21`)
    .bind(command.status, ...(command.before ? [command.before.updatedAt, command.before.id] : []))
    .all<AiJobRow>();
  const items = rows.results.slice(0, 20).map(summary);
  const last = items.at(-1);
  return {
    enabled: aiCatalogEnabled(env),
    evaluationApproved: env.AI_CATALOG_EVALUATION_POLICY === AI_CATALOG_POLICY_KEY,
    model: AI_CATALOG_POLICY.model,
    budget: budget
      ? {
          day: budget.day,
          allowance: budget.allowance_milli / 1000,
          reserved: budget.reserved_milli / 1000,
          startedJobs: budget.started_jobs,
          blocked: Boolean(budget.blocked),
        }
      : null,
    items,
    next: rows.results.length > 20 && last ? { updatedAt: last.updatedAt, id: last.id } : null,
  };
}
export async function aiCatalogDetail(env: AiCatalogEnv, id: string): Promise<AiCatalogDetail> {
  const row = await loadAiJob(env.DB, id);
  if (!row) throw new Error("ai_job_not_found");
  const input = snapshot(row);
  const fresh = Boolean(await freshAiSnapshot(env, row));
  let suggestion = null;
  if (input && row.result_json)
    try {
      suggestion = validateAiSuggestion(input, row.result_json);
    } catch {
      /* Invalid stored results never acquire review authority. */
    }
  const attempts =
    await env.DB.prepare(`SELECT ordinal,day,reserved_milli AS reservedMilli,actual_milli AS actualMilli,
    input_tokens AS inputTokens,output_tokens AS outputTokens,latency_ms AS latencyMs,outcome
    FROM ai_catalog_attempts WHERE job_id = ? ORDER BY ordinal`)
      .bind(id)
      .all<AiCatalogDetail["attempts"][number]>();
  const query = new URLSearchParams({
    q: input?.target.model || "",
    manufacturerId: input?.target.manufacturerId || "",
    aiSuggestionId: id,
    aiCandidateId: String(row.candidate_id),
  });
  return {
    job: summary(row),
    snapshot: input,
    suggestion,
    fresh,
    attempts: attempts.results,
    handoffUrl:
      fresh &&
      row.status === "reviewed" &&
      row.review_outcome === "useful" &&
      suggestion?.decision === "suggestion"
        ? `/?${query}#candidates`
        : null,
  };
}
export async function adminAiCatalog(
  env: AiCatalogEnv,
  input: unknown,
  actor: string,
  now = new Date(),
) {
  const command = parseAiAdminCommand(input);
  if (!command || !actor.trim() || actor.length > 200) throw new Error("invalid_ai_command");
  switch (command.action) {
    case "list":
      return page(env, command, now);
    case "detail":
      return aiCatalogDetail(env, command.id);
    case "prepare": {
      const job = await prepareAiCatalogJob(env, command.candidateId, now);
      return { id: job?.id };
    }
    case "review":
      return recordAiCatalogReview(env, command.id, command.outcome, actor);
    case "retry":
      return retryAiCatalogJob(env, command.id, now);
    case "block":
      await blockAiBudget(env.DB, aiBudgetDay(now), actor);
      return { blocked: true };
    case "grant": {
      const age = now.getTime() - Date.parse(command.checkedAt);
      if (
        age < 0 ||
        age > 15 * 60 * 1000 ||
        aiBudgetDay(new Date(command.checkedAt)) !== aiBudgetDay(now)
      )
        throw new Error("ai_budget_evidence_expired");
      return grantAiBudget(
        env.DB,
        {
          allowanceMilli: command.allowanceNeurons * 1000,
          evidence: JSON.stringify({
            checkedAt: command.checkedAt,
            otherConsumersAccountedFor: true,
            evidence: command.evidence,
          }),
          actor,
        },
        now,
      );
    }
  }
}
