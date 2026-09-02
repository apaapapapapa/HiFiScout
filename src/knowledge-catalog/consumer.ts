/**
 * Queue message handling.
 *
 * This module coordinates: it claims the job, serializes work per manufacturer domain, hands the
 * actual verification to `targets.ts`, and then decides — from the policies in `policy.ts` —
 * whether the outcome is final, worth another attempt, or beyond saving.
 *
 * There are two independent budgets, because two different things go wrong. A *source* attempt is
 * spent when a manufacturer's site fails transiently; a *delivery* attempt is spent when this
 * consumer itself throws. Both end in a dead letter rather than in unbounded redelivery, so a
 * permanently broken job cannot keep a run from finalizing.
 */

import {
  acquireKnowledgeCatalogVerificationDomainLease,
  claimNextKnowledgeCatalogVerificationJobForRun,
  claimKnowledgeCatalogVerificationJob,
  completeKnowledgeCatalogVerificationJob,
  deadLetterKnowledgeCatalogVerificationJob,
  getKnowledgeCatalogVerificationJob,
  incrementKnowledgeCatalogVerificationSourceAttempt,
  knowledgeCatalogVerificationRunWakeState,
  releaseKnowledgeCatalogVerificationDomainLease,
  retryKnowledgeCatalogVerificationJob,
} from "../db/knowledge-catalog-verification-queue-repository.js";
import {
  finishKnowledgeCatalogReviewRunFailure,
  knowledgeCatalogReviewRunStatus,
} from "../db/knowledge-catalog-review-repository.js";
import { finishKnowledgeCatalogVerifierVersionFailure } from "../db/knowledge-catalog-verifier-state-repository.js";
import { finalizeKnowledgeCatalogVerificationRun } from "./finalize.js";
import {
  addSeconds,
  domainLeaseSeconds,
  domainRetrySeconds,
  isRetryableKnowledgeCatalogVerification,
  jobLeaseSeconds,
  knowledgeCatalogRetryDelaySeconds,
  sourceRequestDelayMs,
  transientMaxAttempts,
  wakeMaxJobs,
  wakeWallBudgetMs,
} from "./policy.js";
import {
  isDueProduct,
  isPendingCandidate,
  verifyCandidateTarget,
  verifyProductRecheckTarget,
} from "./targets.js";
import { errorMessage, isRecord } from "../types.js";
import { createVerifier } from "./verifier.js";
import type { KnowledgeCatalogVerificationJob } from "../db/types.js";
import type {
  KnowledgeCatalogJobPayload,
  LegacyKnowledgeCatalogJobMessage,
  KnowledgeCatalogQueueEnv,
  KnowledgeCatalogQueueMessage,
  VerificationTargetResult,
} from "./types.js";
import type { VerifierFactory } from "./verifier.js";

const JOB_TYPES = ["candidate", "product_recheck", "finalize"];

/**
 * A consumer error is redelivered more times than a source failure is retried, because the two
 * mean different things: a source failure is evidence about the manufacturer's site, while a
 * consumer error may be a transient Worker fault worth more chances.
 */
const DELIVERY_ATTEMPT_MULTIPLIER = 2;

interface ProcessedKnowledgeCatalogJob {
  result: Record<string, unknown>;
  retryDelaySeconds?: number;
}

function wait(milliseconds: number): Promise<void> {
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

function isLegacyJobMessage(
  body: KnowledgeCatalogQueueMessage,
): body is LegacyKnowledgeCatalogJobMessage {
  return "jobId" in body;
}

function isDispatchMode(value: unknown): value is KnowledgeCatalogJobPayload["mode"] {
  return value === "daily_candidates" || value === "monthly_recheck";
}

function persistedJobPayload(job: KnowledgeCatalogVerificationJob): KnowledgeCatalogJobPayload {
  let value: unknown;
  try {
    value = JSON.parse(job.payloadJson);
  } catch {
    throw new Error(`knowledge_catalog_job_payload_invalid:${job.id}`);
  }
  if (!isRecord(value) || !isDispatchMode(value.mode)) {
    throw new Error(`knowledge_catalog_job_payload_invalid:${job.id}`);
  }
  return {
    mode: value.mode,
    preferRetries: Boolean(value.preferRetries),
    verifierVersion: Number(value.verifierVersion || 0),
    ...(isRecord(value.target) ? { target: value.target } : {}),
  };
}

function legacyJobPayload(body: LegacyKnowledgeCatalogJobMessage): KnowledgeCatalogJobPayload {
  return {
    mode: body.mode,
    preferRetries: Boolean(body.preferRetries),
    verifierVersion: Number(body.verifierVersion || 0),
    ...(body.target ? { target: body.target } : {}),
  };
}

function unclaimableRetryDelaySeconds(
  env: KnowledgeCatalogQueueEnv,
  job: KnowledgeCatalogVerificationJob,
  now: Date,
): number {
  const retryAt = job.status === "processing" ? job.leaseExpiresAt : job.availableAt;
  const untilRetry = retryAt
    ? Math.ceil((new Date(retryAt).getTime() - now.getTime()) / 1000)
    : domainRetrySeconds(env);
  return Math.max(
    1,
    Math.min(jobLeaseSeconds(env), untilRetry > 0 ? untilRetry : domainRetrySeconds(env)),
  );
}

export interface ConsumeOptions {
  /** Overridable so job processing can be exercised without reaching the network. */
  createVerifier?: VerifierFactory;
}

/**
 * Retries the job when the manufacturer's site failed in a way that may not fail again.
 *
 * Returns whether the job was retried, so the caller knows not to record a final outcome.
 */
async function retrySourceJob(
  env: KnowledgeCatalogQueueEnv,
  payload: KnowledgeCatalogJobPayload,
  job: KnowledgeCatalogVerificationJob,
  result: VerificationTargetResult,
): Promise<ProcessedKnowledgeCatalogJob | null> {
  const sourceAttempts = job.sourceAttempts;
  if (
    !isRetryableKnowledgeCatalogVerification(result.verification) ||
    sourceAttempts >= transientMaxAttempts(env)
  ) {
    return null;
  }
  const delaySeconds = knowledgeCatalogRetryDelaySeconds(sourceAttempts);
  const now = new Date();
  await retryKnowledgeCatalogVerificationJob(
    env.DB,
    job.id,
    addSeconds(now, delaySeconds),
    result.verification.message || `transient_${result.outcome}`,
    now.toISOString(),
  );
  console.warn(
    JSON.stringify({
      event: "knowledge_catalog_queue_source_retry",
      runId: job.runId,
      jobId: job.id,
      targetId: payload.target?.id || null,
      sourceAttempts,
      delaySeconds,
      message: result.verification.message || "",
    }),
  );
  return { result: { status: "retrying" }, retryDelaySeconds: delaySeconds };
}

/**
 * Verifies one target while holding its manufacturer's domain lease.
 *
 * The lease is what keeps concurrent consumers from hitting one manufacturer at once; it is
 * released in a `finally` so a failure cannot leave a domain blocked until the lease expires.
 */
async function consumeSourceJob(
  env: KnowledgeCatalogQueueEnv,
  payload: KnowledgeCatalogJobPayload,
  job: KnowledgeCatalogVerificationJob,
  buildVerifier: VerifierFactory,
): Promise<ProcessedKnowledgeCatalogJob> {
  const now = new Date();
  const hostname = job.hostname;
  const acquired = await acquireKnowledgeCatalogVerificationDomainLease(
    env.DB,
    hostname,
    job.id,
    now.toISOString(),
    domainLeaseSeconds(env),
  );
  if (!acquired) {
    // Deferred before any attempt is counted: waiting its turn is not a failure of the job.
    const delaySeconds = domainRetrySeconds(env);
    await retryKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      addSeconds(now, delaySeconds),
      `domain_busy:${hostname}`,
      now.toISOString(),
    );
    return {
      result: { status: "retrying", reason: "domain_busy", hostname },
      retryDelaySeconds: delaySeconds,
    };
  }

  try {
    const sourceAttempts = await incrementKnowledgeCatalogVerificationSourceAttempt(
      env.DB,
      job.id,
      now.toISOString(),
    );
    job.sourceAttempts = sourceAttempts;
    const verifier = buildVerifier(env);
    let result: VerificationTargetResult;
    if (job.jobType === "product_recheck") {
      if (!isDueProduct(payload.target)) throw new Error("invalid_product_recheck_target");
      result = await verifyProductRecheckTarget(
        env.DB,
        payload.target,
        verifier,
        now.toISOString(),
      );
    } else {
      if (!isPendingCandidate(payload.target)) throw new Error("invalid_candidate_target");
      result = await verifyCandidateTarget(env.DB, payload.target, verifier, now.toISOString());
    }
    const retry = await retrySourceJob(env, payload, job, result);
    if (retry) return retry;

    const finishedAt = new Date().toISOString();
    await completeKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      {
        outcome: result.outcome,
        promoted: result.promoted,
        rechecked: result.rechecked,
        message: result.verification.message || "",
      },
      finishedAt,
    );
    console.log(
      JSON.stringify({
        event: "knowledge_catalog_queue_job_completed",
        runId: job.runId,
        jobId: job.id,
        jobType: job.jobType,
        targetId: payload.target?.id || null,
        manufacturerId: payload.target?.manufacturerId || "",
        outcome: result.outcome,
        sourceAttempts,
      }),
    );
    return { result: { status: "completed", outcome: result.outcome } };
  } finally {
    await releaseKnowledgeCatalogVerificationDomainLease(
      env.DB,
      hostname,
      job.id,
      new Date().toISOString(),
      sourceRequestDelayMs(env),
    );
  }
}

async function processClaimedKnowledgeCatalogVerificationJob(
  env: KnowledgeCatalogQueueEnv,
  job: KnowledgeCatalogVerificationJob,
  buildVerifier: VerifierFactory,
  payloadOverride?: KnowledgeCatalogJobPayload,
): Promise<ProcessedKnowledgeCatalogJob> {
  let payload: KnowledgeCatalogJobPayload = payloadOverride ?? {
    mode: "daily_candidates",
    preferRetries: false,
    verifierVersion: 0,
  };

  try {
    payload = payloadOverride ?? persistedJobPayload(job);
    if (job.jobType === "finalize") {
      const finalized = await finalizeKnowledgeCatalogVerificationRun(env, payload, job);
      if ("delaySeconds" in finalized && Number(finalized.delaySeconds || 0) > 0) {
        const { delaySeconds, ...result } = finalized;
        return { result, retryDelaySeconds: Number(delaySeconds) };
      }
      return { result: finalized };
    }
    return await consumeSourceJob(env, payload, job, buildVerifier);
  } catch (error) {
    const maxAttempts = transientMaxAttempts(env);
    const delaySeconds = knowledgeCatalogRetryDelaySeconds(
      Math.min(job.deliveryAttempts, maxAttempts),
    );
    if (job.deliveryAttempts < maxAttempts * DELIVERY_ATTEMPT_MULTIPLIER) {
      const retryAt = new Date();
      await retryKnowledgeCatalogVerificationJob(
        env.DB,
        job.id,
        addSeconds(retryAt, delaySeconds),
        `consumer_error:${errorMessage(error)}`,
        retryAt.toISOString(),
      );
      console.error(
        JSON.stringify({
          event: "knowledge_catalog_queue_consumer_retry",
          runId: job.runId,
          jobId: job.id,
          delaySeconds,
          message: errorMessage(error),
        }),
      );
      return {
        result: { status: "retrying", reason: "consumer_error" },
        retryDelaySeconds: delaySeconds,
      };
    }

    const finishedAt = new Date().toISOString();
    await deadLetterKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      `consumer_error_exhausted:${errorMessage(error)}`,
      finishedAt,
    );
    // A target job that dies is one missing result; a finalizer that dies leaves the run running.
    if (job.jobType === "finalize") {
      await finishKnowledgeCatalogReviewRunFailure(
        env.DB,
        job.runId,
        finishedAt,
        errorMessage(error),
      );
      if (Number(payload.verifierVersion || 0) > 0) {
        await finishKnowledgeCatalogVerifierVersionFailure(
          env.DB,
          Number(payload.verifierVersion),
          finishedAt,
          errorMessage(error),
        );
      }
    }
    return { result: { status: "dead_letter", reason: "consumer_error_exhausted" } };
  }
}

async function consumeLegacyKnowledgeCatalogJobMessage(
  env: KnowledgeCatalogQueueEnv,
  message: Message<KnowledgeCatalogQueueMessage>,
  body: LegacyKnowledgeCatalogJobMessage,
  buildVerifier: VerifierFactory,
) {
  const jobId = Number(body.jobId || 0);
  const runId = Number(body.runId || 0);
  if (!jobId || !runId || !JOB_TYPES.includes(body.jobType)) {
    console.error(JSON.stringify({ event: "knowledge_catalog_queue_invalid_message", body }));
    message.ack();
    return { status: "ignored", reason: "invalid_message" };
  }

  const now = new Date();
  const job = await claimKnowledgeCatalogVerificationJob(
    env.DB,
    jobId,
    now.toISOString(),
    jobLeaseSeconds(env),
  );
  if (!job) {
    const current = await getKnowledgeCatalogVerificationJob(env.DB, jobId);
    if (!current || current.status === "completed" || current.status === "dead_letter") {
      message.ack();
      return { status: "ignored", reason: "job_terminal_or_missing" };
    }
    const delaySeconds = unclaimableRetryDelaySeconds(env, current, now);
    message.retry({ delaySeconds });
    return {
      status: "retrying",
      reason: current.status === "processing" ? "job_lease_held" : "job_not_ready",
      delaySeconds,
    };
  }

  const processed = await processClaimedKnowledgeCatalogVerificationJob(
    env,
    job,
    buildVerifier,
    legacyJobPayload(body),
  );
  if (processed.retryDelaySeconds) {
    message.retry({ delaySeconds: processed.retryDelaySeconds });
  } else {
    message.ack();
  }
  return processed.result;
}

async function consumeKnowledgeCatalogRunWakeMessage(
  env: KnowledgeCatalogQueueEnv,
  message: Message<KnowledgeCatalogQueueMessage>,
  runId: number,
  buildVerifier: VerifierFactory,
) {
  if (!runId) {
    console.error(
      JSON.stringify({ event: "knowledge_catalog_queue_invalid_message", body: message.body }),
    );
    message.ack();
    return { status: "ignored", reason: "invalid_message" };
  }

  const startedAt = Date.now();
  const maxJobs = wakeMaxJobs(env);
  const wallBudgetMs = wakeWallBudgetMs(env);
  let processedJobs = 0;
  const outcomes: Record<string, number> = {};
  let state: Awaited<ReturnType<typeof knowledgeCatalogVerificationRunWakeState>> | null = null;

  while (
    processedJobs < maxJobs &&
    (processedJobs === 0 || Date.now() - startedAt < wallBudgetMs)
  ) {
    const claimedAt = new Date().toISOString();
    const job = await claimNextKnowledgeCatalogVerificationJobForRun(
      env.DB,
      runId,
      claimedAt,
      jobLeaseSeconds(env),
    );
    if (!job) {
      const observedAt = new Date();
      state = await knowledgeCatalogVerificationRunWakeState(
        env.DB,
        runId,
        observedAt.toISOString(),
      );
      const nextAt = Date.parse(state.nextAvailableAt || "");
      const waitMs = Number.isFinite(nextAt) ? Math.max(0, nextAt - observedAt.getTime()) : 0;
      const remainingWallMs = wallBudgetMs - (Date.now() - startedAt);
      if (
        state.outstandingJobs > 0 &&
        waitMs > 0 &&
        waitMs < remainingWallMs &&
        processedJobs < maxJobs
      ) {
        // A sub-second persistent domain cooldown should not cost another Queue write. Waiting here
        // keeps the old per-domain request spacing while one wake still drains multiple jobs.
        await wait(waitMs);
        state = null;
        continue;
      }
      break;
    }
    state = null;
    const processed = await processClaimedKnowledgeCatalogVerificationJob(env, job, buildVerifier);
    processedJobs += 1;
    const status = String(processed.result.status || "unknown");
    outcomes[status] = (outcomes[status] || 0) + 1;
  }

  const now = new Date();
  state ??= await knowledgeCatalogVerificationRunWakeState(env.DB, runId, now.toISOString());
  let nextDelaySeconds: number | null = null;
  if (state.outstandingJobs > 0) {
    const nextAt = Date.parse(state.nextAvailableAt || "");
    nextDelaySeconds = Number.isFinite(nextAt)
      ? Math.max(1, Math.ceil((nextAt - now.getTime()) / 1000))
      : 1;
    try {
      await env.KNOWLEDGE_CATALOG_QUEUE.send(
        { kind: "knowledge_catalog_run_wakeup", runId },
        { delaySeconds: nextDelaySeconds },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "knowledge_catalog_run_wakeup_enqueue_failed",
          runId,
          processedJobs,
          outstandingJobs: state.outstandingJobs,
          message: errorMessage(error),
        }),
      );
      // Every completed job is terminal in D1, so redelivery safely resumes at the next one.
      message.retry();
      return { status: "retrying", reason: "next_wakeup_enqueue_failed" };
    }
  }

  message.ack();
  const result = {
    status: state.outstandingJobs > 0 ? "continued" : "settled",
    runId,
    processedJobs,
    outstandingJobs: state.outstandingJobs,
    nextDelaySeconds,
    elapsedMs: Date.now() - startedAt,
    outcomes,
  };
  console.log(JSON.stringify({ event: "knowledge_catalog_run_wakeup_processed", ...result }));
  return result;
}

export async function consumeKnowledgeCatalogVerificationMessage(
  env: KnowledgeCatalogQueueEnv,
  message: Message<KnowledgeCatalogQueueMessage>,
  { createVerifier: buildVerifier = createVerifier }: ConsumeOptions = {},
) {
  const body = message.body;
  if (isLegacyJobMessage(body)) {
    return consumeLegacyKnowledgeCatalogJobMessage(env, message, body, buildVerifier);
  }
  return consumeKnowledgeCatalogRunWakeMessage(
    env,
    message,
    Number(body.runId || 0),
    buildVerifier,
  );
}

export async function consumeKnowledgeCatalogVerificationBatch(
  env: KnowledgeCatalogQueueEnv,
  batch: MessageBatch<KnowledgeCatalogQueueMessage>,
  options: ConsumeOptions = {},
): Promise<void> {
  // Sequential: concurrent messages would compete for the same domain leases and mostly defer.
  for (const message of batch.messages) {
    await consumeKnowledgeCatalogVerificationMessage(env, message, options);
  }
}

interface DeadLetteredRunWakeRecovery {
  action: "stale" | "settled" | "rewoken" | "recovery_enqueue_failed";
  runStatus: string | null;
  outstandingJobs: number;
  nextDelaySeconds: number | null;
}

/**
 * A run wake-up contains no unique work; D1 owns every target and the finalizer.
 *
 * An at-least-once duplicate can exhaust delivery after another copy has already progressed or
 * completed the run. Failing durable rows from that stale Queue message would let an obsolete
 * delivery overwrite live work. Instead, terminal runs are ignored and a still-running run with
 * outstanding work gets a fresh wake-up. If that recovery enqueue also fails, the durable rows are
 * intentionally left intact for the scheduled stranded-run watchdog rather than being destroyed.
 */
async function recoverDeadLetteredKnowledgeCatalogRunWake(
  env: KnowledgeCatalogQueueEnv,
  runId: number,
  observedAt: Date,
): Promise<DeadLetteredRunWakeRecovery> {
  const runStatus = await knowledgeCatalogReviewRunStatus(env.DB, runId);
  if (runStatus !== "running") {
    return {
      action: "stale",
      runStatus,
      outstandingJobs: 0,
      nextDelaySeconds: null,
    };
  }

  const state = await knowledgeCatalogVerificationRunWakeState(
    env.DB,
    runId,
    observedAt.toISOString(),
  );
  if (state.outstandingJobs <= 0) {
    return {
      action: "settled",
      runStatus,
      outstandingJobs: 0,
      nextDelaySeconds: null,
    };
  }

  const nextAt = Date.parse(state.nextAvailableAt || "");
  const nextDelaySeconds = Number.isFinite(nextAt)
    ? Math.max(1, Math.ceil((nextAt - observedAt.getTime()) / 1000))
    : 1;
  try {
    await env.KNOWLEDGE_CATALOG_QUEUE.send(
      { kind: "knowledge_catalog_run_wakeup", runId },
      { delaySeconds: nextDelaySeconds },
    );
    return {
      action: "rewoken",
      runStatus,
      outstandingJobs: state.outstandingJobs,
      nextDelaySeconds,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "knowledge_catalog_run_wakeup_dlq_recovery_enqueue_failed",
        runId,
        outstandingJobs: state.outstandingJobs,
        nextDelaySeconds,
        message: errorMessage(error),
      }),
    );
    return {
      action: "recovery_enqueue_failed",
      runStatus,
      outstandingJobs: state.outstandingJobs,
      nextDelaySeconds,
    };
  }
}

/**
 * Last stop for messages Cloudflare gave up redelivering.
 *
 * Legacy messages own one durable job, so their job row is closed and a dead legacy finalizer
 * fails its run. A run-level wake-up owns no durable work and is therefore only recovered or
 * treated as stale; it must never fail rows that another delivery may already be processing.
 */
export async function consumeKnowledgeCatalogVerificationDeadLetterBatch(
  env: KnowledgeCatalogQueueEnv,
  batch: MessageBatch<KnowledgeCatalogQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    const runId = Number(body.runId || 0);
    if (!isLegacyJobMessage(body)) {
      const recovery = runId
        ? await recoverDeadLetteredKnowledgeCatalogRunWake(env, runId, new Date())
        : {
            action: "stale" as const,
            runStatus: null,
            outstandingJobs: 0,
            nextDelaySeconds: null,
          };
      console.error(
        JSON.stringify({
          event: "knowledge_catalog_queue_dead_letter",
          kind: body.kind,
          runId: runId || null,
          ...recovery,
        }),
      );
      message.ack();
      continue;
    }

    const finishedAt = new Date().toISOString();
    const jobId = Number(body.jobId || 0);
    if (jobId) {
      await deadLetterKnowledgeCatalogVerificationJob(
        env.DB,
        jobId,
        "queue_delivery_exhausted",
        finishedAt,
      );
    }
    if (body.jobType === "finalize" && runId) {
      await finishKnowledgeCatalogReviewRunFailure(
        env.DB,
        runId,
        finishedAt,
        "knowledge_catalog_finalizer_delivery_exhausted",
      );
      if (Number(body.verifierVersion || 0) > 0) {
        await finishKnowledgeCatalogVerifierVersionFailure(
          env.DB,
          Number(body.verifierVersion),
          finishedAt,
          "knowledge_catalog_finalizer_delivery_exhausted",
        );
      }
    }
    console.error(
      JSON.stringify({
        event: "knowledge_catalog_queue_dead_letter",
        runId: runId || null,
        jobId: jobId || null,
        jobType: body.jobType || "unknown",
      }),
    );
    message.ack();
  }
}
