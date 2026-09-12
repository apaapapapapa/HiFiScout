import { isRecord } from "../types.js";
import { collectListingCategoryEvidence } from "./category-evidence.js";
import { normalizeCategory } from "./categories.js";
import type { CategoryEvidenceInput } from "./types.js";

function replaySellerEvidence(entry: CategoryEvidenceInput): CategoryEvidenceInput {
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
    if (evidence.length)
      return [
        ...evidence
          .filter((entry) => entry.source !== "title" && entry.source !== "reviewed_product_type")
          .map(replaySellerEvidence),
        ...collectListingCategoryEvidence({
          title: input.title,
          manufacturer: input.manufacturer,
        }).evidence,
      ];
  }
  return collectListingCategoryEvidence(input).evidence;
}
