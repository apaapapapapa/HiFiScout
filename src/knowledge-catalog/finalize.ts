/**
 * Closing out a review run.
 *
 * The finalizer is a job like any other, enqueued behind the targets with a delay. It cannot know
 * when the targets finish, so it re-checks and re-queues itself until nothing is outstanding. That
 * is the whole reason it exists: reclassification has to happen after every verification has
 * landed, or products would be reclassified from a half-populated catalog.
 *
 * It is also what records the run's result, so a run that never finalizes stays `running` — which
 * is why the paths that make finalization impossible fail the run explicitly.
 */

import { reprocessCatalogProductsVerifiedSince } from "../db/knowledge-catalog-remediation-repository.js";
import { reclassifyProductsFromKnowledgeCatalog } from "../db/knowledge-catalog-repository.js";
import {
  activeProductClassificationStats,
  finishKnowledgeCatalogReviewRunSuccess,
  knowledgeCatalogCandidateStats,
  knowledgeCatalogReviewRunStartedAt,
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
  classificationImpact,
  finalizeRetrySeconds,
  remediationListingLimit,
  remediationProductLimit,
} from "./policy.js";
import type { KnowledgeCatalogVerificationJob } from "../db/types.js";
import type { KnowledgeCatalogQueueEnv, KnowledgeCatalogQueueMessage } from "./types.js";

export async function finalizeKnowledgeCatalogVerificationRun(
  env: KnowledgeCatalogQueueEnv,
  body: KnowledgeCatalogQueueMessage,
  message: Message<KnowledgeCatalogQueueMessage>,
  job: KnowledgeCatalogVerificationJob,
) {
  const now = new Date();
  const stats = await knowledgeCatalogVerificationRunStats(env.DB, body.runId);
  if (stats.outstanding > 0) {
    const delaySeconds = finalizeRetrySeconds(env);
    await retryKnowledgeCatalogVerificationJob(
      env.DB,
      job.id,
      addSeconds(now, delaySeconds),
      `waiting_for_${stats.outstanding}_verification_jobs`,
      now.toISOString(),
    );
    message.retry({ delaySeconds });
    return { status: "retrying", reason: "verification_jobs_outstanding", ...stats };
  }

  const beforeClassification = await knowledgeCatalogReviewRunQueueBaseline(env.DB, body.runId);
  // Only now that every verification has landed can listings be re-read against the catalog.
  const reclassifiedProducts = await reclassifyProductsFromKnowledgeCatalog(env.DB);
  // Reclassification corrects the category; this closes the rest of the loop, re-running Product
  // Identity and the Phase 4 projection for the listings each newly verified entry now explains.
  const runStartedAt = await knowledgeCatalogReviewRunStartedAt(env.DB, body.runId);
  const remediation = await reprocessCatalogProductsVerifiedSince(env.DB, {
    since: runStartedAt || new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
    productLimit: remediationProductLimit(env),
    limit: remediationListingLimit(env),
    evaluatedAt: now.toISOString(),
  });
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
    mode: body.mode || "daily_candidates",
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
    retryFirst: Boolean(body.preferRetries),
    beforeClassification,
    afterClassification,
    ...impact,
    reclassifiedProducts,
    remediation,
    message: `${body.mode || "daily_candidates"}: ${stats.promoted} catalog promotions, ${stats.rechecked} source rechecks, ${candidateResult.pendingCandidates} pending candidates, ${impact.unclassifiedReduced} unclassified and ${impact.otherReduced} other listings reduced via queue, ${remediation.matchedCount} listings matched by remediation replay${remediation.incompleteProducts ? ` (${remediation.incompleteProducts} catalog products have listings left to replay)` : ""}`,
  };
  await finishKnowledgeCatalogReviewRunSuccess(env.DB, body.runId, result);
  // Only a run that claimed a rollout version may close it out; an ordinary run carries zero.
  if (Number(body.verifierVersion || 0) > 0) {
    await finishKnowledgeCatalogVerifierVersionSuccess(
      env.DB,
      Number(body.verifierVersion),
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
  message.ack();
  console.log(
    JSON.stringify({ event: "knowledge_catalog_queue_finalized", runId: body.runId, ...result }),
  );
  return result;
}
