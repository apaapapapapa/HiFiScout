import { createKnowledgeSourceVerifier } from './catalog/knowledge-source-verifier.js';
import { createRobotsRespectingFetch } from './crawler/robots-respecting-fetch.js';
import {
  listDueKnowledgeCatalogProducts,
  listPendingKnowledgeCatalogCandidates,
  promoteVerifiedKnowledgeCatalogCandidate,
  recordKnowledgeCatalogCandidateVerification,
  recordKnowledgeCatalogProductRecheckFailure,
  recordKnowledgeCatalogProductRecheckSuccess
} from './db/knowledge-catalog-verification-repository.js';

function boundedLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, Math.trunc(parsed))) : fallback;
}

function sameCategorySet(left = [], right = []) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validPromotion(verification) {
  const categoryIds = [...new Set(verification?.categoryIds || [])].filter(Boolean);
  return verification?.status === 'verified' &&
    Boolean(verification.sourceUrl) &&
    Boolean(verification.canonicalModel) &&
    Boolean(verification.primaryCategoryId) &&
    categoryIds.includes(verification.primaryCategoryId);
}

export async function runKnowledgeCatalogSourceVerification(env, {
  now = new Date(),
  fetchImpl = globalThis.fetch
} = {}) {
  const attemptedAt = now.toISOString();
  const sourceFetch = createRobotsRespectingFetch(fetchImpl, {
    userAgent: env.CRAWLER_USER_AGENT || 'HiFiScoutBot/0.1',
    minimumDelayMs: Number(env.KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS) || 500
  });
  const verifier = createKnowledgeSourceVerifier(env, { fetchImpl: sourceFetch });
  const candidateLimit = boundedLimit(env.KNOWLEDGE_CATALOG_VERIFY_MAX_CANDIDATES, 25);
  const dueProductLimit = boundedLimit(env.KNOWLEDGE_CATALOG_VERIFY_MAX_DUE_PRODUCTS, 25);

  let verificationAttempts = 0;
  let verifiedPromotions = 0;
  let verifiedRechecks = 0;
  let verificationFailures = 0;
  let unsupportedCandidates = 0;

  const dueProducts = await listDueKnowledgeCatalogProducts(env.DB, dueProductLimit);
  for (const product of dueProducts) {
    const verification = await verifier.verifyStoredSource(product);
    verificationAttempts += 1;
    const categoriesStillMatch = verification.status === 'verified' &&
      verification.primaryCategoryId === product.primaryCategoryId &&
      sameCategorySet(verification.categoryIds, product.categoryIds);
    if (categoriesStillMatch) {
      await recordKnowledgeCatalogProductRecheckSuccess(env.DB, product, verification, attemptedAt);
      verifiedRechecks += 1;
    } else {
      const result = verification.status === 'verified'
        ? { ...verification, status: 'ambiguous', message: 'official_category_changed_since_last_verification' }
        : verification;
      await recordKnowledgeCatalogProductRecheckFailure(env.DB, product, result, attemptedAt);
      verificationFailures += 1;
    }
  }

  const candidates = await listPendingKnowledgeCatalogCandidates(env.DB, candidateLimit);
  for (const candidate of candidates) {
    const verification = await verifier.verifyCandidate(candidate);
    verificationAttempts += 1;
    if (verification.status === 'verified') {
      if (!validPromotion(verification)) {
        await recordKnowledgeCatalogCandidateVerification(env.DB, candidate, {
          ...verification,
          status: 'ambiguous',
          message: 'verified_result_missing_required_identity_or_primary_category'
        }, attemptedAt);
        verificationFailures += 1;
        continue;
      }
      const promotion = await promoteVerifiedKnowledgeCatalogCandidate(env.DB, candidate, verification, attemptedAt);
      if (promotion.promoted) verifiedPromotions += 1;
      else if (promotion.reason !== 'already_exists') verificationFailures += 1;
      continue;
    }

    await recordKnowledgeCatalogCandidateVerification(env.DB, candidate, verification, attemptedAt);
    if (verification.status === 'unsupported') unsupportedCandidates += 1;
    else verificationFailures += 1;
  }

  return {
    verificationAttempts,
    verifiedPromotions,
    verifiedRechecks,
    verificationFailures,
    unsupportedCandidates,
    dueProductsChecked: dueProducts.length,
    candidatesChecked: candidates.length
  };
}
