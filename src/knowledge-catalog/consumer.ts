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
  claimKnowledgeCatalogVerificationJob,
  completeKnowledgeCatalogVerificationJob,
  deadLetterKnowledgeCatalogVerificationJob,
  getKnowledgeCatalogVerificationJob,
  incrementKnowledgeCatalogVerificationSourceAttempt,
  releaseKnowledgeCatalogVerificationDomainLease,
  retryKnowledgeCatalogVerificationJob,
} from "../db/knowledge-catalog-verification-queue-repository.js";
import { finishKnowledgeCatalogReviewRunFailure } from "../db/knowledge-catalog-review-repository.js";
import { finishKnowledgeCatalogVerifierVersionFailure } from "../db/knowledge-catalog-verifier-state-repository.js";
import { finalizeKnowledgeCatalogVerificationRun } from "./finalize.js";
import {
  addSeconds,
  domainLeaseSeconds,
  domainRetrySeconds,
  isRetryableKnowledgeCatalogVerification,
  jobLeaseSeconds,
  knowledgeCatalogRetryDelaySeconds,
  transientMaxAttempts,
} from "./policy.js";
import {
  isDueProduct,
  isPendingCandidate,
  verifyCandidateTarget,
  verifyProductRecheckTarget,
} from "./targets.js";
import { errorMessage } from "../types.js";
import { createVerifier } from "./verifier.js";
import type { KnowledgeCatalogVerificationJob } from "../db/types.js";
import type {
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
  body: KnowledgeCatalogQueueMessage,
  message: Message<KnowledgeCatalogQueueMessage>,
  job: KnowledgeCatalogVerificationJob,
  result: VerificationTargetResult,
): Promise<boolean> {
  const sourceAttempts = job.sourceAttempts;
  if (
    !isRetryableKnowledgeCatalogVerification(result.verification) ||
    sourceAttempts >= transientMaxAttempts(env)
  ) {
    return false;
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
  message.retry({ delaySeconds });
  console.warn(
    JSON.stringify({
      event: "knowledge_catalog_queue_source_retry",
      runId: body.runId,
      jobId: job.id,
      targetId: body.target?.id || null,
      sourceAttempts,
      delaySeconds,
      message: result.verification.message || "",
    }),
  );
  return true;
}

/**
 * Verifies one target while holding its manufacturer's domain lease.
 *
 * The lease is what keeps concurrent consumers from hitting one manufacturer at once; it is
 * released in a `finally` so a failure cannot leave a domain blocked until the lease expires.
 */
async function consumeSourceJob(
  env: KnowledgeCatalogQueueEnv,
  body: KnowledgeCatalogQueueMessage,
  message: Message<KnowledgeCatalogQueueMessage>,
  job: KnowledgeCatalogVerificationJob,
  buildVerifier: VerifierFactory,
) {
  const now = new Date();
  const hostname = body.hostname || job.hostname;
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
    message.retry({ delaySeconds });
    return { status: "retrying", reason: "domain_busy", hostname };
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
    if (body.jobType === "product_recheck") {
      if (!isDueProduct(body.target)) throw new Error("invalid_product_recheck_target");
      result = await verifyProductRecheckTarget(env.DB, body.target, verifier, now.toISOString());
    } else {
      if (!isPendingCandidate(body.target)) throw new Error("invalid_candidate_target");
      result = await verifyCandidateTarget(env.DB, body.target, verifier, now.toISOString());
    }
    if (await retrySourceJob(env, body, message, job, result)) return { status: "retrying" };

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
    message.ack();
    console.log(
      JSON.stringify({
        event: "knowledge_catalog_queue_job_completed",
        runId: body.runId,
        jobId: job.id,
        jobType: body.jobType,
        targetId: body.target?.id || null,
        manufacturerId: body.target?.manufacturerId || "",
        outcome: result.outcome,
        sourceAttempts,
      }),
    );
    return { status: "completed", outcome: result.outcome };
  } finally {
    await releaseKnowledgeCatalogVerificationDomainLease(env.DB, hostname, job.id);
  }
}

export async function consumeKnowledgeCatalogVerificationMessage(
  env: KnowledgeCatalogQueueEnv,
  message: Message<KnowledgeCatalogQueueMessage>,
  { createVerifier: buildVerifier = createVerifier }: ConsumeOptions = {},
) {
  const body = message.body;
  const jobId = Number(body.jobId || 0);
  const runId = Number(body.runId || 0);
  if (!jobId || !runId || !JOB_TYPES.includes(body.jobType)) {
    // Nothing can route this; retrying would redeliver it until the queue gave up.
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
    // Redelivery can race a valid D1 lease after a Worker interruption. ACK would delete
    // the only Queue message and strand the row in `processing` forever.
    const delaySeconds = unclaimableRetryDelaySeconds(env, current, now);
    message.retry({ delaySeconds });
    return {
      status: "retrying",
      reason: current.status === "processing" ? "job_lease_held" : "job_not_ready",
      delaySeconds,
    };
  }

  try {
    if (body.jobType === "finalize") {
      return await finalizeKnowledgeCatalogVerificationRun(env, body, message, job);
    }
    return await consumeSourceJob(env, body, message, job, buildVerifier);
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
      message.retry({ delaySeconds });
      console.error(
        JSON.stringify({
          event: "knowledge_catalog_queue_consumer_retry",
          runId,
          jobId,
          delaySeconds,
          message: errorMessage(error),
        }),
      );
      return { status: "retrying", reason: "consumer_error" };
    }

    const finishedAt = new Date().toISOString();
    await deadLetterKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      `consumer_error_exhausted:${errorMessage(error)}`,
      finishedAt,
    );
    // A target job that dies is one missing result; a finalizer that dies leaves the run running.
    if (body.jobType === "finalize") {
      await finishKnowledgeCatalogReviewRunFailure(env.DB, runId, finishedAt, errorMessage(error));
      if (Number(body.verifierVersion || 0) > 0) {
        await finishKnowledgeCatalogVerifierVersionFailure(
          env.DB,
          Number(body.verifierVersion),
          finishedAt,
          errorMessage(error),
        );
      }
    }
    message.ack();
    return { status: "dead_letter", reason: "consumer_error_exhausted" };
  }
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

/**
 * Last stop for messages Cloudflare gave up redelivering.
 *
 * The job row is closed so the finalizer stops waiting on it, and a dead finalizer fails its run
 * so a rollout is never left reporting itself as still running.
 */
export async function consumeKnowledgeCatalogVerificationDeadLetterBatch(
  env: KnowledgeCatalogQueueEnv,
  batch: MessageBatch<KnowledgeCatalogQueueMessage>,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    const jobId = Number(body.jobId || 0);
    const runId = Number(body.runId || 0);
    const finishedAt = new Date().toISOString();
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
