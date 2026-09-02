/**
 * Closing out a review run.
 *
 * The finalizer is a durable job like any other. The run-level selector hides it until the targets
 * are terminal; the legacy job-message path may still reach it early and therefore retains the
 * outstanding-work retry. Reclassification has to happen after every verification has landed, or
 * products would be reclassified from a half-populated catalog.
 *
 * It is also what records the run's result, so a run that never finalizes stays `running` — which
 * is why the paths that make finalization impossible fail the run explicitly.
 */

import { convergeKnowledgeCatalogIdentityDuplicates } from "../db/knowledge-catalog-identity-dedup.js";
import { reprocessPendingCatalogRemediation } from "../db/knowledge-catalog-remediation-repository.js";
import { reclassifyProductsFromKnowledgeCatalog } from "../db/knowledge-catalog-repository.js";
import {
  activeProductClassificationStats,
  finishKnowledgeCatalogReviewRunSuccess,
  knowledgeCatalogReviewRunStatus,
  knowledgeCatalogCandidateStats,
  knowledgeCatalogStats,
} from "../db/knowledge-catalog-review-repository.js";
import {
  completeKnowledgeCatalogVerificationJob,
  knowledgeCatalogReviewRunQueueBaseline,
  knowledgeCatalogVerificationRunStats,
  retryKnowledgeCatalogVerificationJob,
} from "../db/knowledge-catalog-verification-queue-repository.js";
import { finishKnowledgeCatalogVerifierVersionSuccess } from "../db/knowledge-catalog-verifier-state-repository.js";
import {
  addSeconds,
  catalogIdentityConvergenceLimit,
  classificationImpact,
  finalizeRetrySeconds,
  remediationListingLimit,
  remediationProductLimit,
} from "./policy.js";
import type { KnowledgeCatalogVerificationJob } from "../db/types.js";
import type { KnowledgeCatalogJobPayload, KnowledgeCatalogQueueEnv } from "./types.js";

export async function finalizeKnowledgeCatalogVerificationRun(
  env: KnowledgeCatalogQueueEnv,
  payload: KnowledgeCatalogJobPayload,
  job: KnowledgeCatalogVerificationJob,
) {
  const runStatus = await knowledgeCatalogReviewRunStatus(env.DB, job.runId);
  if (runStatus !== "running") {
    // A Worker can finish the run and be interrupted before it closes the finalizer job. A later
    // delivery only repairs that marker; it must not replay remediation/reclassification.
    const finishedAt = new Date().toISOString();
    await completeKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      { outcome: "skipped", message: `run_already_${runStatus || "missing"}` },
      finishedAt,
    );
    return { status: "ignored", reason: `run_${runStatus || "missing"}` };
  }

  const now = new Date();
  const stats = await knowledgeCatalogVerificationRunStats(env.DB, job.runId);
  if (stats.outstanding > 0) {
    const delaySeconds = finalizeRetrySeconds(env);
    await retryKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      addSeconds(now, delaySeconds),
      `waiting_for_${stats.outstanding}_verification_jobs`,
      now.toISOString(),
    );
    return { status: "retrying", reason: "verification_jobs_outstanding", delaySeconds, ...stats };
  }

  const beforeClassification = await knowledgeCatalogReviewRunQueueBaseline(env.DB, job.runId);
  // Catalog rows that name one product are collapsed before anything reads the catalog. Writers can
  // no longer create them, but rows created before the identity rule reached every writer are still
  // there, and leaving them would keep listings for one product split across two catalog entries.
  // Every verification job for this run has finished by now, so no in-flight promotion can be
  // holding an id this pass removes.
  const identityConvergence = await convergeKnowledgeCatalogIdentityDuplicates(env.DB, {
    limit: catalogIdentityConvergenceLimit(env),
    mergedAt: now.toISOString(),
  });
  // A newly verified catalog entry must first pass the existing conservative Product Identity
  // resolver. This replay also refreshes the Phase 4 projection/entity for identities that changed.
  // A survivor of the convergence above is owed a replay too, so its moved listings resolve here.
  const remediation = await reprocessPendingCatalogRemediation(env.DB, {
    productLimit: remediationProductLimit(env),
    limit: remediationListingLimit(env),
    evaluatedAt: now.toISOString(),
  });
  // Only matched canonical identities may now contribute authoritative Knowledge Catalog category
  // evidence. The repository refreshes the product-level search projection again for rows whose
  // category/search aliases changed, so no downstream read model is left stale.
  const reclassifiedProducts = await reclassifyProductsFromKnowledgeCatalog(
    env.DB,
    now.toISOString(),
  );
  const [candidateResult, catalogResult, afterClassification] = await Promise.all([
    knowledgeCatalogCandidateStats(env.DB),
    knowledgeCatalogStats(env.DB),
    activeProductClassificationStats(env.DB),
  ]);
  const impact = classificationImpact(beforeClassification, afterClassification);
  const finishedAt = new Date().toISOString();
  const verificationFailures =
    stats.outcomes.notFound + stats.outcomes.ambiguous + stats.outcomes.error;
  const result = {
    status: "success",
    mode: payload.mode || "daily_candidates",
    finishedAt,
    ...catalogResult,
    ...candidateResult,
    verificationAttempts: stats.sourceAttempts,
    verifiedPromotions: stats.promoted,
    verifiedRechecks: stats.rechecked,
    verificationFailures,
    unsupportedCandidates: stats.outcomes.unsupported,
    verificationOutcomes: stats.outcomes,
    dueProductsChecked: stats.productRecheckJobs,
    candidatesChecked: stats.candidateJobs,
    retryFirst: Boolean(payload.preferRetries),
    beforeClassification,
    afterClassification,
    ...impact,
    reclassifiedProducts,
    remediation,
    identityConvergence,
    message: `${payload.mode || "daily_candidates"}: ${stats.promoted} catalog promotions, ${stats.rechecked} source rechecks, ${candidateResult.pendingCandidates} pending candidates, ${impact.unclassifiedReduced} unclassified and ${impact.otherReduced} other listings reduced via queue, ${remediation.matchedCount} listings matched by remediation replay${remediation.pendingProducts ? ` (${remediation.pendingProducts} catalog products still owed a replay)` : ""}${identityConvergence.removedProducts ? `, ${identityConvergence.removedProducts} duplicate catalog products merged into ${identityConvergence.convergedGroups} canonical products` : ""}`,
  };
  const finished = await finishKnowledgeCatalogReviewRunSuccess(env.DB, job.runId, result);
  // Only a run that claimed a rollout version may close it out; an ordinary run carries zero.
  if (finished && Number(payload.verifierVersion || 0) > 0) {
    await finishKnowledgeCatalogVerifierVersionSuccess(
      env.DB,
      Number(payload.verifierVersion),
      finishedAt,
      result.message,
    );
  }
  // The finalizer has no verification outcome of its own.
  await completeKnowledgeCatalogVerificationJob(
    env.DB,
    job.id,
    { outcome: "skipped", message: "queue_run_finalized" },
    finishedAt,
  );
  if (finished) {
    console.log(
      JSON.stringify({ event: "knowledge_catalog_queue_finalized", runId: job.runId, ...result }),
    );
  }
  return result;
}
