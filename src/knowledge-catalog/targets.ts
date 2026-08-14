/**
 * Verifying one target and recording what it meant.
 *
 * Two kinds of work share this shape. A *candidate* is a listing pattern not yet in the catalog:
 * verifying it may promote it. A *product recheck* re-reads the source of something already in the
 * catalog: verifying it confirms the category is still what the manufacturer says.
 *
 * Both always record an outcome, including failures, because the queue's counters and the retry
 * decision are both read back from what was written here.
 */

import {
  promoteVerifiedKnowledgeCatalogCandidate,
  recordKnowledgeCatalogCandidateVerification,
  recordKnowledgeCatalogProductRecheckFailure,
  recordKnowledgeCatalogProductRecheckSuccess,
} from "../db/knowledge-catalog-verification-repository.js";
import { normalizeOutcome, sameCategorySet, validPromotion } from "./policy.js";
import type {
  FailedKnowledgeSource,
  KnowledgeSourceCandidate,
  KnowledgeSourceVerification,
  KnowledgeSourceVerifier,
} from "../catalog/knowledge-verification/types.js";
import type {
  DueKnowledgeCatalogProduct,
  PendingKnowledgeCatalogCandidate,
  QueryableDatabase,
} from "../db/types.js";
import type { VerificationTargetResult } from "./types.js";

/** Promotion failures that mean the catalog disagrees, not that the run broke. */
const DISAGREEMENT_REASONS = ["identity_changed", "rejected_catalog_identity"];

export function isPendingCandidate(
  target: KnowledgeSourceCandidate | undefined,
): target is PendingKnowledgeCatalogCandidate {
  return Boolean(
    target &&
    typeof target.id === "number" &&
    target.manufacturerId &&
    target.normalizedModel &&
    target.observedManufacturer !== undefined &&
    target.observedModel !== undefined,
  );
}

export function isDueProduct(
  target: KnowledgeSourceCandidate | undefined,
): target is DueKnowledgeCatalogProduct {
  return Boolean(
    target &&
    typeof target.id === "number" &&
    target.manufacturerId &&
    target.normalizedModel &&
    target.canonicalModel &&
    target.canonicalName &&
    typeof target.sourceId === "number" &&
    target.sourceType &&
    target.sourceUrl &&
    Array.isArray(target.categoryIds),
  );
}

export async function verifyCandidateTarget(
  db: QueryableDatabase,
  candidate: PendingKnowledgeCatalogCandidate,
  verifier: KnowledgeSourceVerifier,
  attemptedAt: string,
): Promise<VerificationTargetResult> {
  const verification = await verifier.verifyCandidate(candidate);
  if (verification.status !== "verified") {
    await recordKnowledgeCatalogCandidateVerification(db, candidate, verification, attemptedAt);
    return {
      outcome: normalizeOutcome(verification.status),
      promoted: 0,
      rechecked: 0,
      verification,
    };
  }

  if (!validPromotion(verification)) {
    const result: FailedKnowledgeSource = {
      ...verification,
      status: "ambiguous",
      message: "verified_result_missing_required_identity_or_primary_category",
    };
    await recordKnowledgeCatalogCandidateVerification(db, candidate, result, attemptedAt);
    return { outcome: "ambiguous", promoted: 0, rechecked: 0, verification: result };
  }

  const promotion = await promoteVerifiedKnowledgeCatalogCandidate(
    db,
    candidate,
    verification,
    attemptedAt,
  );
  // An entry another run already created is still a success for this candidate.
  if (promotion.promoted || promotion.reason === "already_exists") {
    return {
      outcome: "verified",
      promoted: promotion.promoted ? 1 : 0,
      rechecked: 0,
      verification,
    };
  }
  const outcome = DISAGREEMENT_REASONS.includes(promotion.reason) ? "ambiguous" : "error";
  return {
    outcome,
    promoted: 0,
    rechecked: 0,
    verification: {
      ...verification,
      status: outcome,
      message: promotion.reason || "catalog_promotion_failed",
    },
  };
}

/**
 * A recheck only succeeds if the categories still match.
 *
 * A page that verifies under a *different* category is the case this exists to catch, so it is
 * recorded as ambiguous rather than as a fresh verification: the catalog entry needs review, not
 * silent overwriting.
 */
export async function verifyProductRecheckTarget(
  db: QueryableDatabase,
  product: DueKnowledgeCatalogProduct,
  verifier: KnowledgeSourceVerifier,
  attemptedAt: string,
): Promise<VerificationTargetResult> {
  const verification = await verifier.verifyStoredSource(product);
  const categoriesStillMatch =
    verification.status === "verified" &&
    verification.primaryCategoryId === product.primaryCategoryId &&
    sameCategorySet(verification.categoryIds, product.categoryIds);
  if (categoriesStillMatch) {
    await recordKnowledgeCatalogProductRecheckSuccess(db, product, verification, attemptedAt);
    return { outcome: "verified", promoted: 0, rechecked: 1, verification };
  }

  const result: KnowledgeSourceVerification =
    verification.status === "verified"
      ? {
          ...verification,
          status: "ambiguous",
          message: "official_category_changed_since_last_verification",
        }
      : verification;
  await recordKnowledgeCatalogProductRecheckFailure(db, product, result, attemptedAt);
  return {
    outcome: normalizeOutcome(result.status),
    promoted: 0,
    rechecked: 0,
    verification: result,
  };
}
