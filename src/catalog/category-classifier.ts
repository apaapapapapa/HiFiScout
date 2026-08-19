import { categoryIdForClassification, categorySearchAliases, getCategory } from "./categories.js";
import {
  CATEGORY_EVIDENCE_STRENGTHS,
  isCategoryEvidenceStrength,
  type CategoryClassification,
  type CategoryEvidenceInput,
  type CategoryEvidenceSummaryItem,
  type CategoryId,
  type ClassificationState,
  type ResolvedCategoryEvidenceItem,
} from "./types.js";

function normalizedEvidence(
  evidence: readonly CategoryEvidenceInput[] = [],
): ResolvedCategoryEvidenceItem[] {
  return evidence
    .map((item) => {
      const values = item.categoryIds ?? (item.categoryId ? [item.categoryId] : []);
      const categoryId =
        values.map((value) => categoryIdForClassification(value)).find(Boolean) || null;
      return {
        categoryId,
        categoryIds: categoryId ? [categoryId] : [],
        source: String(item.source || "unknown"),
        strength: isCategoryEvidenceStrength(item.strength) ? item.strength : "supporting",
        value: String(item.value || "").slice(0, 240),
      };
    })
    .filter((item): item is ResolvedCategoryEvidenceItem => item.categoryId !== null);
}

function unresolved(
  state: Exclude<ClassificationState, "classified">,
  evidence: readonly ResolvedCategoryEvidenceItem[],
): CategoryClassification {
  const candidateCategoryIds = [...new Set(evidence.map((item) => item.categoryId))];
  return {
    primaryCategoryId: "other",
    categoryIds: [],
    displayName: "未分類",
    classificationStatus: "unclassified",
    classificationState: state,
    classificationReason: state === "ambiguous" ? "conflicting_evidence" : "insufficient_evidence",
    classificationSource: state,
    candidateCategoryIds,
    searchAliases: "",
  };
}

function classified(
  categoryId: CategoryId,
  tierEvidence: readonly ResolvedCategoryEvidenceItem[],
): CategoryClassification {
  const primary = getCategory(categoryId);
  const sources = [
    ...new Set(
      tierEvidence.filter((item) => item.categoryId === categoryId).map((item) => item.source),
    ),
  ];
  return {
    primaryCategoryId: primary?.id || "other",
    categoryIds: [primary?.id || "other"],
    displayName: primary?.name || "その他",
    classificationStatus: "classified",
    classificationState: "classified",
    classificationReason: "",
    classificationSource: sources.join("+") || "classified",
    candidateCategoryIds: [],
    searchAliases: categorySearchAliases([primary?.id || "other"]),
  };
}

export function classifyCategoryEvidence(
  rawEvidence: readonly CategoryEvidenceInput[] = [],
): CategoryClassification {
  const evidence = normalizedEvidence(rawEvidence);
  // Supporting evidence is deliberately the last tier. It may classify a product only when
  // verified/authoritative/strong evidence is absent, so broad seller buckets remain useful as a
  // fallback without overriding a more specific title or detail-page classification.
  for (const strength of CATEGORY_EVIDENCE_STRENGTHS) {
    const tier = evidence.filter((item) => item.strength === strength);
    if (!tier.length) continue;
    const ids = [...new Set(tier.map((item) => item.categoryId))];
    if (ids.length !== 1) return unresolved("ambiguous", tier);
    const categoryId = ids[0];
    if (categoryId) return classified(categoryId, tier);
  }
  return unresolved("unclassified", evidence);
}

export function summarizeCategoryEvidence(
  rawEvidence: readonly CategoryEvidenceInput[] = [],
): CategoryEvidenceSummaryItem[] {
  return normalizedEvidence(rawEvidence)
    .slice(0, 12)
    .map((item) => ({
      categoryIds: item.categoryIds,
      source: item.source,
      strength: item.strength,
      value: item.value.slice(0, 160),
    }));
}
