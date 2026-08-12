import {
  activeProductClassificationStats,
  finishKnowledgeCatalogReviewRunFailure,
  finishKnowledgeCatalogReviewRunSuccess,
  knowledgeCatalogCandidateStats,
  knowledgeCatalogStats,
  markKnowledgeCatalogProductsDue,
  refreshKnowledgeCatalogCandidates,
  startKnowledgeCatalogReviewRun,
} from "./db/knowledge-catalog-review-repository.js";
import { reclassifyProductsFromKnowledgeCatalog } from "./db/knowledge-catalog-repository.js";
import { runKnowledgeCatalogSourceVerification } from "./knowledge-catalog-source-verification.js";

function reviewIntervalDays(env) {
  return Math.max(1, Number(env.KNOWLEDGE_CATALOG_REVIEW_INTERVAL_DAYS) || 30);
}

export function summarizeClassificationImpact(beforeClassification, afterClassification) {
  return {
    unclassifiedReduced: Math.max(
      0,
      beforeClassification.unclassifiedProducts - afterClassification.unclassifiedProducts,
    ),
    otherReduced: Math.max(
      0,
      beforeClassification.otherProducts - afterClassification.otherProducts,
    ),
  };
}

export function knowledgeCatalogReviewModeOptions(mode = "full") {
  if (mode === "daily_candidates") {
    return {
      mode,
      markDueProducts: false,
      verifyCandidates: true,
      verifyDueProducts: false,
    };
  }
  if (mode === "monthly_recheck") {
    return {
      mode,
      markDueProducts: true,
      verifyCandidates: false,
      verifyDueProducts: true,
    };
  }
  return {
    mode: "full",
    markDueProducts: true,
    verifyCandidates: true,
    verifyDueProducts: true,
  };
}

export async function runKnowledgeCatalogReview(
  env,
  {
    now = new Date(),
    fetchImpl = globalThis.fetch,
    runId: existingRunId = null,
    preferRetries = false,
    mode = "full",
  } = {},
) {
  const startedAt = now.toISOString();
  const runId = existingRunId || (await startKnowledgeCatalogReviewRun(env.DB, startedAt));
  const reviewMode = knowledgeCatalogReviewModeOptions(mode);

  try {
    const beforeClassification = await activeProductClassificationStats(env.DB);
    if (reviewMode.markDueProducts) {
      await markKnowledgeCatalogProductsDue(env.DB, startedAt, reviewIntervalDays(env));
    }
    await refreshKnowledgeCatalogCandidates(env.DB, startedAt);
    const verificationResult = await runKnowledgeCatalogSourceVerification(env, {
      now,
      fetchImpl,
      preferRetries,
      verifyCandidates: reviewMode.verifyCandidates,
      verifyDueProducts: reviewMode.verifyDueProducts,
    });
    const candidateResult = await knowledgeCatalogCandidateStats(env.DB);
    const reclassifiedProducts = await reclassifyProductsFromKnowledgeCatalog(env.DB);
    const afterClassification = await activeProductClassificationStats(env.DB);
    const impact = summarizeClassificationImpact(beforeClassification, afterClassification);
    const stats = await knowledgeCatalogStats(env.DB);
    const finishedAt = new Date().toISOString();
    const result = {
      status: "success",
      mode: reviewMode.mode,
      finishedAt,
      ...stats,
      ...candidateResult,
      ...verificationResult,
      beforeClassification,
      afterClassification,
      ...impact,
      reclassifiedProducts,
      message: `${reviewMode.mode}: ${verificationResult.verifiedPromotions} catalog promotions, ${verificationResult.verifiedRechecks} source rechecks, ${candidateResult.pendingCandidates} pending candidates, ${impact.unclassifiedReduced} unclassified and ${impact.otherReduced} other listings reduced`,
    };
    await finishKnowledgeCatalogReviewRunSuccess(env.DB, runId, result);
    console.log(JSON.stringify({ event: "knowledge_catalog_review", ...result }));
    return result;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await finishKnowledgeCatalogReviewRunFailure(
      env.DB,
      runId,
      finishedAt,
      error?.message || String(error),
    );
    console.error(
      JSON.stringify({
        event: "knowledge_catalog_review_failed",
        mode: reviewMode.mode,
        message: error?.message || String(error),
      }),
    );
    throw error;
  }
}

export function runKnowledgeCatalogDailyVerification(env, options = {}) {
  return runKnowledgeCatalogReview(env, { ...options, mode: "daily_candidates" });
}

export function runKnowledgeCatalogMonthlyRecheck(env, options = {}) {
  return runKnowledgeCatalogReview(env, { ...options, mode: "monthly_recheck" });
}
