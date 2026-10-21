/**
 * Opening a review run and waking its durable work.
 *
 * A run is a row plus a set of D1 jobs and one finalizer. Queue receives only the run id; every
 * target and retry boundary survives independently in D1. If that first wake-up cannot be sent,
 * its next scheduled attempt sends the same run id and preserves completed target results.
 *
 * The two modes queue mutually exclusive work. `daily_candidates` verifies listing patterns not yet
 * in the catalog; `monthly_recheck` marks verified products stale and re-reads their sources.
 */

import { prepareScheduledKnowledgeCatalogCandidates } from "../db/knowledge-catalog-candidate-refresh.js";
import { withinD1Budget } from "../db/invocation-budget.js";
import {
  activeProductClassificationStats,
  markKnowledgeCatalogProductsDue,
  claimScheduledKnowledgeCatalogReviewRun,
} from "../db/knowledge-catalog-review-repository.js";
import {
  createKnowledgeCatalogVerificationJobs,
  inheritKnowledgeCatalogVerificationJobs,
  knowledgeCatalogVerificationRunStats,
  setKnowledgeCatalogReviewRunQueueBaseline,
} from "../db/knowledge-catalog-verification-queue-repository.js";
import {
  listDueKnowledgeCatalogProducts,
  listPendingKnowledgeCatalogCandidates,
} from "../db/knowledge-catalog-verification-repository.js";
import {
  candidateLimit,
  dueProductLimit,
  finalizerJobKey,
  reviewIntervalDays,
  targetJobKey,
} from "./policy.js";
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
    requestKey = now.toISOString().slice(0, 10),
    mode,
    preferRetries = false,
    verifierVersion = 0,
    runId: existingRunId = 0,
    recoveryOfRunId = 0,
  }: DispatchRunOptions,
) {
  // Checked before the run row is created: a run whose jobs can never be enqueued would sit
  // `running` until an operator noticed.
  if (!env.KNOWLEDGE_CATALOG_QUEUE?.send) {
    throw new Error("knowledge_catalog_queue_binding_missing");
  }

  // Preparation may span Cron invocations. Do not open a review run until it has finished.
  const refresh = await prepareScheduledKnowledgeCatalogCandidates(env.DB, now, requestKey);
  // Admission precedes the run claim. Both job insertion and its read-back fit this unit, so a
  // cooperative budget yield owns no half-dispatched run. The maintenance completion uses reserve.
  return withinD1Budget(
    env.DB,
    (mode === "monthly_recheck" ? 8 : 7) + Number(!!recoveryOfRunId),
    async () => {
      const startedAt = now.toISOString();
      const run = await claimScheduledKnowledgeCatalogReviewRun(env.DB, {
        key: existingRunId
          ? `recovery:${existingRunId}`
          : `${mode}:${requestKey}:v${verifierVersion}`,
        generation: refresh.generation,
        targetDate: requestKey,
        startedAt,
        runId: existingRunId,
      });
      const runId = run.id;
      if (!run.ready && run.status === "running" && recoveryOfRunId) {
        run.ready = await inheritKnowledgeCatalogVerificationJobs(
          env.DB,
          runId,
          recoveryOfRunId,
          startedAt,
        );
      }
      if (run.ready || run.status !== "running") {
        const stats = await knowledgeCatalogVerificationRunStats(env.DB, runId);
        const wake = run.status === "running";
        if (wake)
          await env.KNOWLEDGE_CATALOG_QUEUE.send({ kind: "knowledge_catalog_run_wakeup", runId });
        return {
          status: wake ? "queued" : "skipped",
          mode,
          runId,
          queuedTargets: stats.candidateJobs + stats.productRecheckJobs,
          enqueueFailures: 0,
          candidateTargets: stats.candidateJobs,
          productRecheckTargets: stats.productRecheckJobs,
          verifierVersion,
          durableJobs: stats.candidateJobs + stats.productRecheckJobs + Number(run.ready),
          queueMessages: Number(wake),
          resumed: true,
        };
      }
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
      if (!jobs.some((job) => job.jobType === "finalize")) {
        throw new Error(`knowledge_catalog_job_persist_mismatch:${jobs.length}/${jobSpecs.length}`);
      }
      // A send can reach Queue even when its acknowledgement is lost. Keep the durable run/jobs;
      // a later maintenance attempt sends the same run ID and claims skip completed targets.
      await env.KNOWLEDGE_CATALOG_QUEUE.send({ kind: "knowledge_catalog_run_wakeup", runId });

      const result = {
        status: "queued",
        mode,
        runId,
        queuedTargets: jobs.length - 1,
        enqueueFailures: 0,
        candidateTargets: jobs.filter((job) => job.jobType === "candidate").length,
        productRecheckTargets: jobs.filter((job) => job.jobType === "product_recheck").length,
        verifierVersion,
        durableJobs: jobs.length,
        queueMessages: 1,
      };
      console.log(JSON.stringify({ event: "knowledge_catalog_queue_dispatched", ...result }));
      return result;
    },
  );
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
