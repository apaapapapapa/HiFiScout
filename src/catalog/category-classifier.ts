import { categoryIdForClassification, categorySearchAliases, getCategory } from "./categories.js";

const STRENGTHS = new Set(["verified", "authoritative", "strong", "supporting"]);

function normalizedEvidence(evidence = []) {
  return evidence
    .map((item) => {
      const values = item?.categoryIds || (item?.categoryId ? [item.categoryId] : []);
      const categoryId =
        values.map((value) => categoryIdForClassification(value)).find(Boolean) || null;
      return {
        categoryId,
        categoryIds: categoryId ? [categoryId] : [],
        source: String(item?.source || "unknown"),
        strength: STRENGTHS.has(item?.strength) ? item.strength : "supporting",
        value: String(item?.value || "").slice(0, 240),
      };
    })
    .filter((item) => item.categoryId);
}

function unresolved(state, evidence) {
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

function classified(categoryId, tierEvidence) {
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

export function classifyCategoryEvidence(rawEvidence = []) {
  const evidence = normalizedEvidence(rawEvidence);
  for (const strength of ["verified", "authoritative", "strong"]) {
    const tier = evidence.filter((item) => item.strength === strength);
    if (!tier.length) continue;
    const ids = [...new Set(tier.map((item) => item.categoryId))];
    if (ids.length !== 1) return unresolved("ambiguous", tier);
    return classified(ids[0], tier);
  }
  return unresolved("unclassified", evidence);
}

export function summarizeCategoryEvidence(rawEvidence = []) {
  return normalizedEvidence(rawEvidence)
    .slice(0, 12)
    .map((item) => ({
      categoryIds: item.categoryIds,
      source: item.source,
      strength: item.strength,
      value: item.value.slice(0, 160),
    }));
}
