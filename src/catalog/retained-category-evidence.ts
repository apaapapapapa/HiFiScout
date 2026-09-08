import { isRecord } from "../types.js";
import { categoryEvidenceFromText, collectListingCategoryEvidence } from "./category-evidence.js";
import type { CategoryEvidenceInput } from "./types.js";

/** Replay and admin preview share the retained evidence; only title-derived decisions are recomputed. */
export function retainedCategoryEvidence(
  input: { title: string; rawCategory: string; hintedCategory: string },
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
        ...evidence.filter((entry) => entry.source !== "title"),
        ...categoryEvidenceFromText(input.title),
      ];
  }
  return collectListingCategoryEvidence(input).evidence;
}
