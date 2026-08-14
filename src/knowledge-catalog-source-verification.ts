import { createKnowledgeSourceVerifierV4 } from "./catalog/knowledge-source-verifier-v4.js";
import { createRobotsRespectingFetch } from "./crawler/robots-respecting-fetch.js";
import {
  listDueKnowledgeCatalogProducts,
  listPendingKnowledgeCatalogCandidates,
  promoteVerifiedKnowledgeCatalogCandidate,
  recordKnowledgeCatalogCandidateVerification,
  recordKnowledgeCatalogProductRecheckFailure,
  recordKnowledgeCatalogProductRecheckSuccess,
} from "./db/knowledge-catalog-verification-repository.js";
import type {
  FailedKnowledgeSource,
  KnowledgeSourceStatus,
  VerifiedKnowledgeSource,
} from "./catalog/types.js";
import type { CrawlerEnv } from "./crawler/types.js";
import type { KnowledgeCatalogVerificationOutcomes, QueryableDatabase } from "./db/types.js";

type KnowledgeCatalogRuntimeEnv = CrawlerEnv & { DB: QueryableDatabase };

interface SourceVerificationOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
  preferRetries?: boolean;
  verifyCandidates?: boolean;
  verifyDueProducts?: boolean;
}

function boundedLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(2000, Math.max(1, Math.trunc(parsed))) : fallback;
}

function sameCategorySet(left: readonly string[] = [], right: readonly string[] = []): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validPromotion(verification: VerifiedKnowledgeSource): boolean {
  const categoryIds = [...new Set(verification?.categoryIds || [])].filter(Boolean);
  return (
    verification?.status === "verified" &&
    Boolean(verification.sourceUrl) &&
    Boolean(verification.canonicalModel) &&
    Boolean(verification.primaryCategoryId) &&
    categoryIds.includes(verification.primaryCategoryId)
  );
}

function emptyOutcomeCounts(): KnowledgeCatalogVerificationOutcomes {
  return { verified: 0, notFound: 0, ambiguous: 0, unsupported: 0, error: 0 };
}

function countOutcome(
  counts: KnowledgeCatalogVerificationOutcomes,
  status: KnowledgeSourceStatus,
): void {
  if (status === "verified") counts.verified += 1;
  else if (status === "not_found") counts.notFound += 1;
  else if (status === "ambiguous") counts.ambiguous += 1;
  else if (status === "unsupported") counts.unsupported += 1;
  else counts.error += 1;
}

export async function runKnowledgeCatalogSourceVerification(
  env: KnowledgeCatalogRuntimeEnv,
  {
    now = new Date(),
    fetchImpl = globalThis.fetch,
    preferRetries = false,
    verifyCandidates = true,
    verifyDueProducts = true,
  }: SourceVerificationOptions = {},
) {
  const attemptedAt = now.toISOString();
  const sourceFetch = createRobotsRespectingFetch(fetchImpl, {
    userAgent: env.CRAWLER_USER_AGENT || "HiFiScoutBot/0.1",
    minimumDelayMs: Number(env.KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS) || 500,
  });
  const verifier = createKnowledgeSourceVerifierV4(env, {
    fetchImpl: sourceFetch,
    // Retry-only rollouts avoid the expensive generic sitemap fallback. Normal reviews and source
    // expansion rollouts retain it so newly supported manufacturers can populate the catalog.
    fallbackEnabled: !preferRetries,
  });
  const supportedManufacturerIds = [...verifier.definitions.keys()];
  const candidateLimit = boundedLimit(
    env.KNOWLEDGE_CATALOG_DAILY_VERIFY_MAX_CANDIDATES ??
      env.KNOWLEDGE_CATALOG_VERIFY_MAX_CANDIDATES,
    50,
  );
  const dueProductLimit = boundedLimit(env.KNOWLEDGE_CATALOG_VERIFY_MAX_DUE_PRODUCTS, 25);

  let verificationAttempts = 0;
  let verifiedPromotions = 0;
  let verifiedRechecks = 0;
  let verificationFailures = 0;
  let unsupportedCandidates = 0;
  const verificationOutcomes = emptyOutcomeCounts();

  const dueProducts = verifyDueProducts
    ? await listDueKnowledgeCatalogProducts(env.DB, dueProductLimit)
    : [];
  for (const product of dueProducts) {
    const verification = await verifier.verifyStoredSource(product);
    verificationAttempts += 1;
    const categoriesStillMatch =
      verification.status === "verified" &&
      verification.primaryCategoryId === product.primaryCategoryId &&
      sameCategorySet(verification.categoryIds, product.categoryIds);
    if (categoriesStillMatch) {
      await recordKnowledgeCatalogProductRecheckSuccess(env.DB, product, verification, attemptedAt);
      verifiedRechecks += 1;
      countOutcome(verificationOutcomes, "verified");
    } else {
      const result: FailedKnowledgeSource =
        verification.status === "verified"
          ? {
              sourceUrl: verification.sourceUrl,
              sourceType: verification.sourceType,
              httpStatus: verification.httpStatus,
              contentHash: verification.contentHash,
              status: "ambiguous",
              message: "official_category_changed_since_last_verification",
            }
          : verification;
      await recordKnowledgeCatalogProductRecheckFailure(env.DB, product, result, attemptedAt);
      verificationFailures += 1;
      countOutcome(verificationOutcomes, result.status);
    }
  }

  const candidates = verifyCandidates
    ? await listPendingKnowledgeCatalogCandidates(
        env.DB,
        candidateLimit,
        supportedManufacturerIds,
        { preferRetries },
      )
    : [];
  for (const candidate of candidates) {
    const verification = await verifier.verifyCandidate(candidate);
    verificationAttempts += 1;
    if (verification.status === "verified") {
      if (!validPromotion(verification)) {
        await recordKnowledgeCatalogCandidateVerification(
          env.DB,
          candidate,
          {
            ...verification,
            status: "ambiguous",
            message: "verified_result_missing_required_identity_or_primary_category",
          },
          attemptedAt,
        );
        verificationFailures += 1;
        countOutcome(verificationOutcomes, "ambiguous");
        continue;
      }
      const promotion = await promoteVerifiedKnowledgeCatalogCandidate(
        env.DB,
        candidate,
        verification,
        attemptedAt,
      );
      if (promotion.promoted) {
        verifiedPromotions += 1;
        countOutcome(verificationOutcomes, "verified");
      } else if (promotion.reason === "already_exists") {
        countOutcome(verificationOutcomes, "verified");
      } else {
        verificationFailures += 1;
        countOutcome(
          verificationOutcomes,
          promotion.reason === "identity_changed" ||
            promotion.reason === "rejected_catalog_identity"
            ? "ambiguous"
            : "error",
        );
      }
      continue;
    }

    await recordKnowledgeCatalogCandidateVerification(env.DB, candidate, verification, attemptedAt);
    countOutcome(verificationOutcomes, verification.status);
    if (verification.status === "unsupported") unsupportedCandidates += 1;
    else verificationFailures += 1;
  }

  return {
    verificationAttempts,
    verifiedPromotions,
    verifiedRechecks,
    verificationFailures,
    unsupportedCandidates,
    verificationOutcomes,
    dueProductsChecked: dueProducts.length,
    candidatesChecked: candidates.length,
    supportedManufacturers: supportedManufacturerIds.length,
    retryFirst: preferRetries,
  };
}
