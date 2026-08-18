/**
 * Opening a review run and enqueueing its work.
 *
 * A run is a row plus a set of jobs plus one finalizer. Dispatch's obligation is that those three
 * stay consistent: if the finalizer cannot be enqueued, nothing will ever close the run out, so the
 * run is failed here rather than left `running` forever.
 *
 * The two modes queue mutually exclusive work. `daily_candidates` verifies listing patterns not yet
 * in the catalog; `monthly_recheck` marks verified products stale and re-reads their sources.
 */

import {
  activeProductClassificationStats,
  finishKnowledgeCatalogReviewRunFailure,
  markKnowledgeCatalogProductsDue,
  refreshKnowledgeCatalogCandidates,
  startKnowledgeCatalogReviewRun,
} from "../db/knowledge-catalog-review-repository.js";
import {
  createKnowledgeCatalogVerificationJobs,
  deadLetterKnowledgeCatalogVerificationJob,
  setKnowledgeCatalogReviewRunQueueBaseline,
} from "../db/knowledge-catalog-verification-queue-repository.js";
import {
  listDueKnowledgeCatalogProducts,
  listPendingKnowledgeCatalogCandidates,
} from "../db/knowledge-catalog-verification-repository.js";
import { finishKnowledgeCatalogVerifierVersionFailure } from "../db/knowledge-catalog-verifier-state-repository.js";
import {
  candidateLimit,
  dueProductLimit,
  finalizerJobKey,
  reviewIntervalDays,
  targetJobKey,
} from "./policy.js";
import { errorMessage } from "../types.js";
import { createVerifier, sourceHostname } from "./verifier.js";
import type { KnowledgeCatalogJobType, KnowledgeCatalogVerificationJobSpec } from "../db/types.js";
import type {
  DispatchOptions,
  DispatchRunOptions,
  KnowledgeCatalogQueueEnv,
  KnowledgeCatalogQueueMessage,
} from "./types.js";

/** Cloudflare's per-call limit for `sendBatch`. */
const QUEUE_SEND_BATCH_SIZE = 100;

/** Long enough that the first targets are usually done before the finalizer first checks. */
const FINALIZER_DELAY_SECONDS = 60;

/**
 * Enqueues target messages, dead-lettering any chunk the queue rejects.
 *
 * A message that was never enqueued has a job row that nothing will ever claim, and the finalizer
 * waits on outstanding jobs — so the job is closed here instead of stalling the run.
 */
async function sendTargetMessages(
  env: KnowledgeCatalogQueueEnv,
  messages: readonly KnowledgeCatalogQueueMessage[],
): Promise<number> {
  let failed = 0;
  for (let index = 0; index < messages.length; index += QUEUE_SEND_BATCH_SIZE) {
    const chunk = messages.slice(index, index + QUEUE_SEND_BATCH_SIZE);
    try {
      await env.KNOWLEDGE_CATALOG_QUEUE.sendBatch(chunk.map((body) => ({ body })));
    } catch (error) {
      const finishedAt = new Date().toISOString();
      failed += chunk.length;
      for (const body of chunk) {
        await deadLetterKnowledgeCatalogVerificationJob(
          env.DB,
          body.jobId,
          `queue_enqueue_failed:${errorMessage(error)}`,
          finishedAt,
        );
      }
    }
  }
  return failed;
}

async function dispatchKnowledgeCatalogVerificationRun(
  env: KnowledgeCatalogQueueEnv,
  {
    now = new Date(),
    mode,
    preferRetries = false,
    verifierVersion = 0,
    runId: existingRunId = 0,
  }: DispatchRunOptions,
) {
  // Checked before the run row is created: a run whose jobs can never be enqueued would sit
  // `running` until an operator noticed.
  if (!env.KNOWLEDGE_CATALOG_QUEUE?.sendBatch || !env.KNOWLEDGE_CATALOG_QUEUE?.send) {
    throw new Error("knowledge_catalog_queue_binding_missing");
  }

  const startedAt = now.toISOString();
  const runId = existingRunId || (await startKnowledgeCatalogReviewRun(env.DB, startedAt));
  try {
    // Recorded up front because the finalizer runs much later and reports the difference.
    const beforeClassification = await activeProductClassificationStats(env.DB);
    await setKnowledgeCatalogReviewRunQueueBaseline(
      env.DB,
      runId,
      beforeClassification,
      `${mode}: queue dispatch started`,
    );
    if (mode === "monthly_recheck") {
      await markKnowledgeCatalogProductsDue(env.DB, startedAt, reviewIntervalDays(env));
    }
    await refreshKnowledgeCatalogCandidates(env.DB, startedAt);

    const verifier = createVerifier(env);
    const supportedManufacturerIds = [...verifier.definitions.keys()];
    const targets =
      mode === "monthly_recheck"
        ? await listDueKnowledgeCatalogProducts(env.DB, dueProductLimit(env))
        : await listPendingKnowledgeCatalogCandidates(
            env.DB,
            candidateLimit(env),
            supportedManufacturerIds,
            { preferRetries },
          );
    const jobType: KnowledgeCatalogJobType =
      mode === "monthly_recheck" ? "product_recheck" : "candidate";
    const jobSpecs: KnowledgeCatalogVerificationJobSpec[] = targets.map((target) => ({
      jobKey: targetJobKey(runId, jobType, target.id),
      jobType,
      targetId: target.id,
      manufacturerId: target.manufacturerId,
      hostname: sourceHostname(verifier, target.manufacturerId, target.sourceUrl || ""),
    }));
    jobSpecs.push({
      jobKey: finalizerJobKey(runId),
      jobType: "finalize",
      targetId: null,
      manufacturerId: "",
      hostname: "",
    });
    const jobs = await createKnowledgeCatalogVerificationJobs(env.DB, runId, jobSpecs, startedAt);
    const byKey = new Map(jobs.map((job) => [job.jobKey, job]));
    const targetMessages = targets.map((target) => {
      const job = byKey.get(targetJobKey(runId, jobType, target.id));
      if (!job) throw new Error(`knowledge_catalog_job_missing:${target.id}`);
      return {
        jobId: job.id,
        runId,
        jobType,
        mode,
        preferRetries,
        verifierVersion,
        hostname: job.hostname,
        target,
      };
    });
    const enqueueFailures = await sendTargetMessages(env, targetMessages);
    const finalizer = byKey.get(finalizerJobKey(runId));
    if (!finalizer) throw new Error("knowledge_catalog_finalizer_job_missing");
    try {
      await env.KNOWLEDGE_CATALOG_QUEUE.send(
        {
          jobId: finalizer.id,
          runId,
          jobType: "finalize",
          mode,
          preferRetries,
          verifierVersion,
        },
        { delaySeconds: FINALIZER_DELAY_SECONDS },
      );
    } catch (error) {
      // Without a finalizer the run has no way to complete, so it is failed now rather than left
      // for an operator to discover.
      const finishedAt = new Date().toISOString();
      await deadLetterKnowledgeCatalogVerificationJob(
        env.DB,
        finalizer.id,
        `finalizer_enqueue_failed:${errorMessage(error)}`,
        finishedAt,
      );
      await finishKnowledgeCatalogReviewRunFailure(
        env.DB,
        runId,
        finishedAt,
        "knowledge_catalog_finalizer_enqueue_failed",
      );
      if (verifierVersion > 0) {
        await finishKnowledgeCatalogVerifierVersionFailure(
          env.DB,
          verifierVersion,
          finishedAt,
          "knowledge_catalog_finalizer_enqueue_failed",
        );
      }
      throw error;
    }

    const result = {
      status: "queued",
      mode,
      runId,
      queuedTargets: targetMessages.length - enqueueFailures,
      enqueueFailures,
      candidateTargets: jobType === "candidate" ? targets.length : 0,
      productRecheckTargets: jobType === "product_recheck" ? targets.length : 0,
      verifierVersion,
    };
    console.log(JSON.stringify({ event: "knowledge_catalog_queue_dispatched", ...result }));
    return result;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    // The finalizer-enqueue branch above may already have failed the run; re-failing it would
    // overwrite the more specific reason it recorded.
    const row = await env.DB.prepare(
      "SELECT status FROM knowledge_catalog_review_runs WHERE id = ?",
    )
      .bind(runId)
      .first();
    if (row?.status === "running") {
      await finishKnowledgeCatalogReviewRunFailure(env.DB, runId, finishedAt, errorMessage(error));
    }
    if (verifierVersion > 0) {
      await finishKnowledgeCatalogVerifierVersionFailure(
        env.DB,
        verifierVersion,
        finishedAt,
        errorMessage(error),
      );
    }
    throw error;
  }
}

export function dispatchKnowledgeCatalogDailyVerification(
  env: KnowledgeCatalogQueueEnv,
  options: DispatchOptions = {},
) {
  return dispatchKnowledgeCatalogVerificationRun(env, { ...options, mode: "daily_candidates" });
}

export function dispatchKnowledgeCatalogMonthlyRecheck(
  env: KnowledgeCatalogQueueEnv,
  options: DispatchOptions = {},
) {
  return dispatchKnowledgeCatalogVerificationRun(env, { ...options, mode: "monthly_recheck" });
}
