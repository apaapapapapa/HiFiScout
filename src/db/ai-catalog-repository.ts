import type {
  AiCatalogSnapshot,
  AiCatalogSuggestion,
  AiReviewOutcome,
} from "../api/admin-ai-contracts.js";
import {
  AI_CATALOG_POLICY,
  AI_CATALOG_POLICY_KEY,
  aiBudgetDay,
  aiReservationMilliNeurons,
} from "../ai-suggestions/policy.js";
import type { AiBudgetRow, AiJobRow } from "../ai-suggestions/types.js";
import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase } from "./types.js";

export const loadAiJob = (db: QueryableDatabase, id: string) =>
  firstMeasured<AiJobRow>(db.prepare("SELECT * FROM ai_catalog_jobs WHERE id = ?").bind(id));
export const loadAiBudget = (db: QueryableDatabase, day: string) =>
  firstMeasured<AiBudgetRow>(
    db.prepare("SELECT * FROM ai_catalog_budgets WHERE day = ?").bind(day),
  );

/** One immutable daily grant. Repeating a request cannot reset spent/reserved capacity. */
export async function grantAiBudget(
  db: QueryableDatabase,
  input: { allowanceMilli: number; evidence: string; actor: string },
  now = new Date(),
) {
  if (
    !Number.isSafeInteger(input.allowanceMilli) ||
    input.allowanceMilli < 0 ||
    input.allowanceMilli > AI_CATALOG_POLICY.maxNeuronsPerDay * 1000 ||
    !input.evidence.trim() ||
    input.evidence.length > 1000 ||
    !input.actor.trim()
  )
    throw new Error("invalid_ai_budget");
  await db
    .prepare(`INSERT INTO ai_catalog_budgets(day,policy_key,allowance_milli,account_evidence,approved_by,created_at)
    SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM ai_catalog_budgets WHERE day = ?)`)
    .bind(
      aiBudgetDay(now),
      AI_CATALOG_POLICY_KEY,
      input.allowanceMilli,
      input.evidence,
      input.actor,
      now.toISOString(),
      aiBudgetDay(now),
    )
    .run();
  return loadAiBudget(db, aiBudgetDay(now));
}
export async function blockAiBudget(db: QueryableDatabase, day: string) {
  await db
    .prepare("UPDATE ai_catalog_budgets SET blocked = 1 WHERE day = ? AND blocked = 0")
    .bind(day)
    .run();
}
export async function insertAiJob(
  db: QueryableDatabase,
  id: string,
  snapshot: AiCatalogSnapshot,
  now = new Date(),
) {
  const result = await db
    .prepare(`INSERT INTO ai_catalog_jobs(id,candidate_id,snapshot_json,status,created_at,updated_at)
    SELECT ?,?,?,'queued',?,? WHERE NOT EXISTS (SELECT 1 FROM ai_catalog_jobs WHERE id = ?)`)
    .bind(
      id,
      snapshot.target.candidateId,
      JSON.stringify(snapshot),
      now.toISOString(),
      now.toISOString(),
      id,
    )
    .run();
  return result.meta.changes > 0;
}

/** D1 batch is atomic: the attempt, budget reservation and lease succeed together. */
export async function reserveAiAttempt(db: QueryableDatabase, id: string, now = new Date()) {
  const token = crypto.randomUUID();
  const day = aiBudgetDay(now);
  const amount = aiReservationMilliNeurons();
  const results = await db.batch([
    db
      .prepare(`INSERT INTO ai_catalog_attempts(token,job_id,ordinal,day,reserved_milli,created_at)
      SELECT ?,j.id,j.attempts + 1,b.day,?,? FROM ai_catalog_jobs j
      JOIN ai_catalog_budgets b ON b.day = ? WHERE j.id = ? AND j.status = 'queued'
      AND j.attempts < ? AND b.blocked = 0 AND b.policy_key = ?
      AND b.reserved_milli + ? <= b.allowance_milli
      AND (EXISTS (SELECT 1 FROM ai_catalog_attempts a WHERE a.job_id = j.id AND a.day = b.day) OR b.started_jobs < ?)`)
      .bind(
        token,
        amount,
        now.toISOString(),
        day,
        id,
        AI_CATALOG_POLICY.maxAttempts,
        AI_CATALOG_POLICY_KEY,
        amount,
        AI_CATALOG_POLICY.maxJobsPerDay,
      ),
    db
      .prepare(`UPDATE ai_catalog_budgets SET reserved_milli = reserved_milli + ?,
      started_jobs = started_jobs + (SELECT CASE WHEN EXISTS
        (SELECT 1 FROM ai_catalog_attempts prior WHERE prior.job_id = current.job_id
          AND prior.day = current.day AND prior.token <> current.token) THEN 0 ELSE 1 END
        FROM ai_catalog_attempts current WHERE token = ?)
      WHERE day = ? AND EXISTS (SELECT 1 FROM ai_catalog_attempts WHERE token = ?)`)
      .bind(amount, token, day, token),
    db
      .prepare(`UPDATE ai_catalog_jobs SET status = 'processing',attempts = attempts + 1,
      attempt_token = ?,lease_until = ?,updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM ai_catalog_attempts WHERE token = ?)`)
      .bind(
        token,
        new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        now.toISOString(),
        id,
        token,
      ),
  ]);
  return results[0].meta.changes > 0 ? { token, day } : null;
}
export async function finishAiAttempt(
  db: QueryableDatabase,
  input: {
    jobId: string;
    token: string;
    status: AiJobRow["status"];
    result: AiCatalogSuggestion | null;
    error: string;
    inputTokens: number | null;
    outputTokens: number | null;
    actualMilli: number | null;
    latencyMs: number;
  },
  now = new Date(),
) {
  await db.batch([
    db
      .prepare(`UPDATE ai_catalog_attempts SET input_tokens = ?,output_tokens = ?,actual_milli = ?,latency_ms = ?,outcome = ?
      WHERE token = ? AND outcome = 'reserved'`)
      .bind(
        input.inputTokens,
        input.outputTokens,
        input.actualMilli,
        input.latencyMs,
        input.error || input.status,
        input.token,
      ),
    db
      .prepare(`UPDATE ai_catalog_jobs SET status = ?,result_json = ?,error_code = ?,lease_until = NULL,updated_at = ?
      WHERE id = ? AND status = 'processing' AND attempt_token = ?`)
      .bind(
        input.status,
        input.result ? JSON.stringify(input.result) : null,
        input.error,
        now.toISOString(),
        input.jobId,
        input.token,
      ),
  ]);
}
export async function setAiJobStatus(
  db: QueryableDatabase,
  id: string,
  from: AiJobRow["status"],
  to: AiJobRow["status"],
  error: string,
  now = new Date(),
) {
  await db
    .prepare(
      "UPDATE ai_catalog_jobs SET status = ?,error_code = ?,updated_at = ? WHERE id = ? AND status = ?",
    )
    .bind(to, error, now.toISOString(), id, from)
    .run();
}
export async function reviewAiJob(
  db: QueryableDatabase,
  id: string,
  outcome: AiReviewOutcome,
  actor: string,
  now = new Date(),
) {
  const result = await db
    .prepare(`UPDATE ai_catalog_jobs SET status = 'reviewed',review_outcome = ?,reviewed_by = ?,reviewed_at = ?,updated_at = ?
    WHERE id = ? AND status IN ('suggested','no_suggestion') AND review_outcome IS NULL`)
    .bind(outcome, actor, now.toISOString(), now.toISOString(), id)
    .run();
  return result.meta.changes > 0;
}
