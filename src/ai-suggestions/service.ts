import {
  AiContractError,
  aiSnapshotFingerprint,
  buildAiRequest,
  eligibleAiCandidates,
  parseAiSnapshot,
  validateAiSelection,
} from "./contract.js";
import {
  AI_CATALOG_POLICY,
  AI_CATALOG_POLICY_KEY,
  aiBudgetDay,
  aiUsageMilliNeurons,
} from "./policy.js";
import {
  blockAiBudget,
  abstainAiJob,
  finishAiAttempt,
  insertAiJob,
  loadAiBudget,
  loadAiJob,
  reserveAiAttempt,
  reviewAiJob,
  setAiJobStatus,
} from "../db/ai-catalog-repository.js";
import { loadAiCatalogSnapshot } from "../db/ai-catalog-snapshot.js";
import { accountReads } from "../db/read-accounting.js";
import { isRecord } from "../types.js";
import type { AiCatalogEnv, AiCatalogMessage, AiJobRow } from "./types.js";
import type {
  AiCatalogSnapshot,
  AiCatalogSuggestion,
  AiReviewOutcome,
} from "../api/admin-ai-contracts.js";

export function aiCatalogEnabled(env: AiCatalogEnv) {
  return (
    env.AI_CATALOG_ENABLED === "true" &&
    env.AI_CATALOG_EVALUATION_POLICY === AI_CATALOG_POLICY_KEY &&
    Boolean(env.AI && env.AI_CATALOG_QUEUE)
  );
}
export function isAiCatalogMessage(value: unknown): value is AiCatalogMessage {
  return (
    isRecord(value) &&
    value.kind === "ai_catalog_job" &&
    typeof value.jobId === "string" &&
    /^[a-f0-9]{64}$/u.test(value.jobId)
  );
}
function storedSnapshot(job: AiJobRow): AiCatalogSnapshot | null {
  try {
    return parseAiSnapshot(JSON.parse(job.snapshot_json));
  } catch {
    return null;
  }
}
export async function freshAiSnapshot(env: AiCatalogEnv, job: AiJobRow) {
  const current = await loadAiCatalogSnapshot(env.DB, job.candidate_id);
  return current && (await aiSnapshotFingerprint(current)) === job.id ? current : null;
}
export async function prepareAiCatalogJob(
  env: AiCatalogEnv,
  candidateId: number,
  now = new Date(),
) {
  if (!Number.isSafeInteger(candidateId) || candidateId < 1)
    throw new Error("invalid_ai_candidate");
  const snapshot = await loadAiCatalogSnapshot(env.DB, candidateId);
  if (!snapshot) throw new Error("ai_candidate_not_eligible");
  const eligible = eligibleAiCandidates(snapshot).length > 0;
  if (eligible) buildAiRequest(snapshot);
  const id = await aiSnapshotFingerprint(snapshot);
  const inserted = await insertAiJob(env.DB, id, snapshot, now);
  if (inserted) {
    if (!eligible) await abstainAiJob(env.DB, id, now);
    else if (aiCatalogEnabled(env)) {
      // Persist first; maintenance recovers an interrupted or failed send without another AI job.
      try {
        await env.AI_CATALOG_QUEUE!.send({ kind: "ai_catalog_job", jobId: id });
      } catch {
        /* The durable queued row is the recovery cursor. */
      }
    } else await setAiJobStatus(env.DB, id, "queued", "deferred", "feature_disabled", now);
  }
  return loadAiJob(env.DB, id);
}

/** No provider text, exception text, seller input or raw response is emitted to logs. */
export async function processAiCatalogJob(env: AiCatalogEnv, id: string, now = new Date()) {
  const job = await loadAiJob(env.DB, id);
  if (!job || job.status !== "queued") return;
  if (!aiCatalogEnabled(env))
    return setAiJobStatus(env.DB, id, "queued", "deferred", "feature_disabled", now);
  if (now.getUTCHours() === 23 && now.getUTCMinutes() >= 45)
    return setAiJobStatus(env.DB, id, "queued", "deferred", "budget_reset_window", now);
  const snapshot = storedSnapshot(job);
  if (!snapshot || !(await freshAiSnapshot(env, job)))
    return setAiJobStatus(env.DB, id, "queued", "stale", "target_changed", now);
  if (!eligibleAiCandidates(snapshot).length) return abstainAiJob(env.DB, id, now);
  let request: ReturnType<typeof buildAiRequest>;
  try {
    request = buildAiRequest(snapshot);
  } catch {
    return setAiJobStatus(env.DB, id, "queued", "invalid", "input_too_large", now);
  }
  const claim = await reserveAiAttempt(env.DB, id, now);
  if (!claim) {
    // A duplicate delivery may lose the claim to another invocation; the conditional write leaves it alone.
    return setAiJobStatus(env.DB, id, "queued", "deferred", "budget_unavailable", now);
  }
  let result: AiCatalogSuggestion | null = null;
  let status: AiJobRow["status"] = "invalid";
  let error = "invalid_response";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let actualMilli: number | null = null;
  const started = Date.now();
  try {
    const raw: unknown = await env.AI!.run(
      AI_CATALOG_POLICY.model,
      {
        ...request,
        response_format: { ...request.response_format, type: "json_schema" },
      },
      {
        signal: AbortSignal.timeout(60_000),
        extraHeaders: { "cf-aig-collect-log-payload": "false" },
      },
    );
    if (isRecord(raw) && isRecord(raw.usage)) {
      const usage = raw.usage;
      if (typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
        actualMilli = aiUsageMilliNeurons(usage.prompt_tokens, usage.completion_tokens);
        if (actualMilli !== null) {
          inputTokens = usage.prompt_tokens;
          outputTokens = usage.completion_tokens;
        }
      }
      if (
        typeof usage.total_tokens !== "number" ||
        usage.total_tokens !== (inputTokens ?? 0) + (outputTokens ?? 0)
      )
        actualMilli = null;
    }
    if (
      actualMilli === null ||
      inputTokens! > AI_CATALOG_POLICY.maxInputTokens ||
      outputTokens! > AI_CATALOG_POLICY.maxOutputTokens
    ) {
      await blockAiBudget(env.DB, claim.day);
      error = "usage_unverified";
    } else {
      result = validateAiSelection(snapshot, isRecord(raw) ? raw.response : raw);
      status = result.decision === "suggestion" ? "suggested" : "no_suggestion";
      error = "";
    }
  } catch (failure) {
    if (failure instanceof AiContractError) error = failure.message;
    else {
      // A timeout/error may still be billed. Keep its full reservation and stop this day's allowance.
      await blockAiBudget(env.DB, claim.day);
      status = "deferred";
      error = "provider_error_usage_unknown";
    }
  }
  // The seller/canonical evidence may have changed while the inference was in flight.
  if (!(await freshAiSnapshot(env, job))) {
    status = "stale";
    result = null;
    error = "target_changed";
  }
  await finishAiAttempt(
    env.DB,
    {
      jobId: id,
      token: claim.token,
      status,
      result,
      error,
      inputTokens,
      outputTokens,
      actualMilli,
      latencyMs: Date.now() - started,
    },
    new Date(),
  );
}

export async function consumeAiCatalogBatch(
  env: AiCatalogEnv,
  batch: MessageBatch<AiCatalogMessage>,
  deadLetter = false,
) {
  for (const message of batch.messages) {
    if (!isAiCatalogMessage(message.body)) {
      message.ack();
      continue;
    }
    const accounting = accountReads(env.DB);
    try {
      if (deadLetter) {
        for (const status of ["queued", "processing"] as const)
          await setAiJobStatus(accounting.db, message.body.jobId, status, "failed", "dead_letter");
      } else await processAiCatalogJob({ ...env, DB: accounting.db }, message.body.jobId);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 300 });
    } finally {
      console.log(
        JSON.stringify({
          event: "ai_catalog_d1_usage",
          jobId: message.body.jobId,
          rowsRead: accounting.rowsRead(),
          rowsWritten: accounting.rowsWritten(),
          statements: accounting.statementCount(),
        }),
      );
    }
  }
}

/** Bounded, indexed recovery. Deferred quota rows need an explicit operator retry on a new grant. */
export async function maintainAiCatalogJobs(env: AiCatalogEnv, now = new Date()) {
  const retention = new Date(
    now.getTime() - AI_CATALOG_POLICY.retentionDays * 86400000,
  ).toISOString();
  await env.DB.prepare(`DELETE FROM ai_catalog_jobs WHERE id IN (SELECT id FROM ai_catalog_jobs
    WHERE created_at < ? ORDER BY created_at,id LIMIT 25)`)
    .bind(retention)
    .run();
  await env.DB.prepare(`DELETE FROM ai_catalog_budgets WHERE day IN (SELECT day FROM ai_catalog_budgets
    WHERE day < ? ORDER BY day LIMIT 25)`)
    .bind(retention.slice(0, 10))
    .run();
  const cutoff = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const expired = await env.DB.prepare(`SELECT id,attempt_token FROM ai_catalog_jobs
    WHERE status = 'processing' AND updated_at < ? ORDER BY updated_at,id LIMIT 5`)
    .bind(cutoff)
    .all<{ id: string; attempt_token: string }>();
  // No automatic reinference after a hard kill: usage cannot be proven. Reservations survive.
  for (const row of expired.results) {
    await setAiJobStatus(
      env.DB,
      row.id,
      "processing",
      "deferred",
      "lease_expired_usage_unknown",
      now,
    );
    await env.DB.prepare(`UPDATE ai_catalog_budgets SET blocked = 1 WHERE blocked = 0 AND day IN
      (SELECT day FROM ai_catalog_attempts WHERE token = ?)`)
      .bind(row.attempt_token)
      .run();
  }
  if (!aiCatalogEnabled(env)) return { enabled: false, requeued: 0 };
  const budget = await loadAiBudget(env.DB, aiBudgetDay(now));
  if (!budget || budget.blocked) return { enabled: true, requeued: 0 };
  const pending = await env.DB.prepare(`SELECT id FROM ai_catalog_jobs WHERE status = 'queued'
    AND updated_at < ? ORDER BY updated_at,id LIMIT 5`)
    .bind(cutoff)
    .all<{ id: string }>();
  for (const row of pending.results) {
    await env.DB.prepare(
      "UPDATE ai_catalog_jobs SET updated_at = ? WHERE id = ? AND status = 'queued'",
    )
      .bind(now.toISOString(), row.id)
      .run();
    await env.AI_CATALOG_QUEUE!.send({ kind: "ai_catalog_job", jobId: row.id });
  }
  return { enabled: true, requeued: pending.results.length };
}

export async function recordAiCatalogReview(
  env: AiCatalogEnv,
  id: string,
  outcome: AiReviewOutcome,
  actor: string,
) {
  const job = await loadAiJob(env.DB, id);
  if (!job || !["suggested", "no_suggestion"].includes(job.status))
    throw new Error("ai_review_unavailable");
  if (!(await freshAiSnapshot(env, job))) {
    await setAiJobStatus(env.DB, id, job.status, "stale", "target_changed");
    throw new Error("ai_review_stale");
  }
  if (!["useful", "incorrect", "insufficient_evidence"].includes(outcome) || !actor.trim())
    throw new Error("invalid_ai_review");
  // Recording usefulness never writes a product, alias or listing. Existing Verify remains separate.
  return { reviewed: await reviewAiJob(env.DB, id, outcome, actor) };
}

export async function retryAiCatalogJob(env: AiCatalogEnv, id: string, now = new Date()) {
  const job = await loadAiJob(env.DB, id);
  if (!job || job.status !== "deferred" || job.attempts >= AI_CATALOG_POLICY.maxAttempts)
    throw new Error("ai_retry_unavailable");
  if (!aiCatalogEnabled(env)) throw new Error("ai_feature_disabled");
  const budget = await loadAiBudget(env.DB, aiBudgetDay(now));
  if (!budget || budget.blocked) throw new Error("ai_budget_unavailable");
  await setAiJobStatus(env.DB, id, "deferred", "queued", "", now);
  await env.AI_CATALOG_QUEUE!.send({ kind: "ai_catalog_job", jobId: id });
  return { queued: true };
}
