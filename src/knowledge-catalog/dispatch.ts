/**
 * Opening a review run and waking its durable work.
 *
 * A run is a row plus a set of D1 jobs and one finalizer. Queue receives only the run id; every
 * target and retry boundary survives independently in D1. If that first wake-up cannot be sent,
 * nothing can discover the rows, so dispatch closes them instead of leaving a `running` orphan.
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
  deadLetterOutstandingKnowledgeCatalogVerificationJobsForRun,
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
  KnowledgeCatalogJobPayload,
  KnowledgeCatalogQueueEnv,
} from "./types.js";

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
  if (!env.KNOWLEDGE_CATALOG_QUEUE?.send) {
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
    const payload = (target?: (typeof targets)[number]): string =>
      JSON.stringify({
        mode,
        preferRetries,
        verifierVersion,
        target,
      } satisfies KnowledgeCatalogJobPayload);
    const jobSpecs: KnowledgeCatalogVerificationJobSpec[] = targets.map((target) => ({
      jobKey: targetJobKey(runId, jobType, target.id),
      jobType,
      targetId: target.id,
      manufacturerId: target.manufacturerId,
      hostname: sourceHostname(verifier, target.manufacturerId, target.sourceUrl || ""),
      payloadJson: payload(target),
    }));
    jobSpecs.push({
      jobKey: finalizerJobKey(runId),
      jobType: "finalize",
      targetId: null,
      manufacturerId: "",
      hostname: "",
      payloadJson: payload(),
    });
    const jobs = await createKnowledgeCatalogVerificationJobs(env.DB, runId, jobSpecs, startedAt);
    if (jobs.length !== jobSpecs.length) {
      throw new Error(`knowledge_catalog_job_persist_mismatch:${jobs.length}/${jobSpecs.length}`);
    }
    try {
      await env.KNOWLEDGE_CATALOG_QUEUE.send({ kind: "knowledge_catalog_run_wakeup", runId });
    } catch (error) {
      // No Queue message can discover these rows. Close them and the run together so the existing
      // failed-run recovery can create a clean successor after Queue quota recovers.
      const finishedAt = new Date().toISOString();
      await deadLetterOutstandingKnowledgeCatalogVerificationJobsForRun(
        env.DB,
        runId,
        finishedAt,
        `run_wakeup_enqueue_failed:${errorMessage(error)}`,
      );
      await finishKnowledgeCatalogReviewRunFailure(
        env.DB,
        runId,
        finishedAt,
        "knowledge_catalog_run_wakeup_enqueue_failed",
      );
      if (verifierVersion > 0) {
        await finishKnowledgeCatalogVerifierVersionFailure(
          env.DB,
          verifierVersion,
          finishedAt,
          "knowledge_catalog_run_wakeup_enqueue_failed",
        );
      }
      throw error;
    }

    const result = {
      status: "queued",
      mode,
      runId,
      queuedTargets: targets.length,
      enqueueFailures: 0,
      candidateTargets: jobType === "candidate" ? targets.length : 0,
      productRecheckTargets: jobType === "product_recheck" ? targets.length : 0,
      verifierVersion,
      durableJobs: jobs.length,
      queueMessages: 1,
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
