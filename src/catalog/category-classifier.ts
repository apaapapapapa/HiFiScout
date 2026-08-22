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

const SAFE_SUPPORTING_SELLER_FALLBACKS: ReadonlyMap<string, CategoryId> = new Map([
  ["アクセサリー", "other_accessory"],
  ["ケーブル", "cable_other"],
  ["カートリッジ", "cartridge"],
  ["cartridge", "cartridge"],
]);

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

function safeSupportingSellerFallback(
  evidence: readonly ResolvedCategoryEvidenceItem[],
): CategoryClassification | null {
  const tier = evidence.filter((item) => item.strength === "supporting");
  if (!tier.length) return null;

  const safeSeller = tier.find((item) => {
    if (item.source !== "seller_category") return false;
    const value = item.value.normalize("NFKC").trim().toLowerCase();
    const expected = SAFE_SUPPORTING_SELLER_FALLBACKS.get(value);
    return expected === item.categoryId;
  });
  if (!safeSeller) return null;

  // Do not turn a supporting-tier disagreement into an arbitrary classification. A safe broad
  // seller bucket is usable only when every other supporting signal points to that same leaf.
  if (tier.some((item) => item.categoryId !== safeSeller.categoryId)) {
    return unresolved("ambiguous", tier);
  }
  return classified(safeSeller.categoryId, tier);
}

export function classifyCategoryEvidence(
  rawEvidence: readonly CategoryEvidenceInput[] = [],
): CategoryClassification {
  const evidence = normalizedEvidence(rawEvidence);
  for (const strength of CATEGORY_EVIDENCE_STRENGTHS.slice(0, 3)) {
    const tier = evidence.filter((item) => item.strength === strength);
    if (!tier.length) continue;
    const ids = [...new Set(tier.map((item) => item.categoryId))];
    if (ids.length !== 1) return unresolved("ambiguous", tier);
    const categoryId = ids[0];
    if (categoryId) return classified(categoryId, tier);
  }

  // Supporting/corroborative evidence remains non-classifying by default. The only exceptions are
  // exact generic seller buckets whose leaf is semantically certain and intentionally broad. This
  // also makes persisted v9 evidence replayable after the classifier version is bumped.
  return safeSupportingSellerFallback(evidence) || unresolved("unclassified", evidence);
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
