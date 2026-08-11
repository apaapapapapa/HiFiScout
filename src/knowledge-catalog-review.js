import {
  finishKnowledgeCatalogReviewRunFailure,
  finishKnowledgeCatalogReviewRunSuccess,
  knowledgeCatalogCandidateStats,
  knowledgeCatalogStats,
  markKnowledgeCatalogProductsDue,
  refreshKnowledgeCatalogCandidates,
  startKnowledgeCatalogReviewRun
} from './db/knowledge-catalog-review-repository.js';
import { reclassifyProductsFromKnowledgeCatalog } from './db/knowledge-catalog-repository.js';
import { runKnowledgeCatalogSourceVerification } from './knowledge-catalog-source-verification.js';

function reviewIntervalDays(env) {
  return Math.max(1, Number(env.KNOWLEDGE_CATALOG_REVIEW_INTERVAL_DAYS) || 30);
}

export async function runKnowledgeCatalogReview(env, { now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  const startedAt = now.toISOString();
  const runId = await startKnowledgeCatalogReviewRun(env.DB, startedAt);

  try {
    await markKnowledgeCatalogProductsDue(env.DB, startedAt, reviewIntervalDays(env));
    await refreshKnowledgeCatalogCandidates(env.DB, startedAt);
    const verificationResult = await runKnowledgeCatalogSourceVerification(env, { now, fetchImpl });
    const candidateResult = await knowledgeCatalogCandidateStats(env.DB);
    const reclassifiedProducts = await reclassifyProductsFromKnowledgeCatalog(env.DB);
    const stats = await knowledgeCatalogStats(env.DB);
    const finishedAt = new Date().toISOString();
    const result = {
      status: 'success',
      finishedAt,
      ...stats,
      ...candidateResult,
      ...verificationResult,
      reclassifiedProducts,
      message: `${verificationResult.verifiedPromotions} catalog promotions, ${verificationResult.verifiedRechecks} source rechecks, ${candidateResult.pendingCandidates} pending candidates, ${stats.dueProducts} verified products still due`
    };
    await finishKnowledgeCatalogReviewRunSuccess(env.DB, runId, result);
    console.log(JSON.stringify({ event: 'knowledge_catalog_review', ...result }));
    return result;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await finishKnowledgeCatalogReviewRunFailure(env.DB, runId, finishedAt, error?.message || String(error));
    console.error(JSON.stringify({
      event: 'knowledge_catalog_review_failed',
      message: error?.message || String(error)
    }));
    throw error;
  }
}
