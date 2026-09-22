import { isRecord } from "../types.js";
import { collectListingCategoryEvidence } from "./category-evidence.js";
import { normalizeCategory } from "./categories.js";
import type { CategoryEvidenceInput, CategoryNormalizationConfig } from "./types.js";

function replaySellerEvidence(entry: CategoryEvidenceInput): CategoryEvidenceInput {
  // Fujiya is the owner of detail_breadcrumb evidence. Its old cached summaries omitted ruleId;
  // retain the raw label while applying the current reviewed authority of that breadcrumb.
  if (
    entry.source === "detail_breadcrumb" &&
    (!entry.ruleId || /^fujiya\.product_breadcrumb\.v[34]$/.test(entry.ruleId)) &&
    entry.value
      ?.normalize("NFKC")
      .replace(/\(中古\)$/, "")
      .trim() === "アナログプレーヤー" &&
    entry.categoryIds?.includes("ANA.TURNTABLE")
  )
    return { ...entry, strength: "supporting" };
  if (entry.source !== "seller_category" || !entry.value) return entry;
  const current = normalizeCategory({ rawCategory: entry.value });
  // Reinterpret retained vocabulary without escalating its shop-declared authority. Opaque
  // shop mappings and independently collected detail/catalog/manual evidence remain retained.
  return current.classificationStatus === "classified"
    ? { ...entry, categoryId: undefined, categoryIds: current.categoryIds }
    : entry;
}

/** Replay and preview recompute derived decisions from retained raw evidence, without fetching. */
export function retainedCategoryEvidence(
  input: { title: string; rawCategory: string; hintedCategory: string; manufacturer?: string },
  metadata: Record<string, unknown>,
  config: CategoryNormalizationConfig = {},
): CategoryEvidenceInput[] {
  const classification = isRecord(metadata.categoryClassification)
    ? metadata.categoryClassification
    : {};
  const stored = classification.evidence;
  if (Array.isArray(stored)) {
    const evidence = stored.filter(
      (entry): entry is CategoryEvidenceInput =>
        isRecord(entry) &&
        Array.isArray(entry.categoryIds) &&
        typeof entry.source === "string" &&
        typeof entry.strength === "string",
    );
    if (evidence.length) {
      // Stored seller evidence records the policy decision made by the old resolver. When the
      // composition boundary supplies current shop policy, rebuild that source from the retained
      // raw label so a newly reviewed exact mapping can become authoritative. Preserve opaque
      // legacy mappings when the current configuration cannot produce a replacement.
      const shopAware = config.categoryMapping !== undefined || config.categoryPolicy !== undefined;
      const current = collectListingCategoryEvidence({
        title: input.title,
        manufacturer: input.manufacturer,
        ...(shopAware
          ? {
              rawCategory: input.rawCategory,
              categoryMapping: config.categoryMapping,
              categoryPolicy: config.categoryPolicy,
            }
          : {}),
      }).evidence;
      const hasCurrentSellerEvidence = current.some((entry) => entry.source === "seller_category");
      return [
        ...evidence
          .filter(
            (entry) =>
              entry.source !== "title" &&
              entry.source !== "reviewed_product_type" &&
              !(hasCurrentSellerEvidence && entry.source === "seller_category"),
          )
          .map(replaySellerEvidence),
        ...current,
      ];
    }
  }
  return collectListingCategoryEvidence({ ...input, ...config }).evidence;
}
