/**
 * Manufacturer model families whose category the official page states less clearly than its name.
 *
 * These are corrections applied after verification, not a discovery route: the page did confirm the
 * model, and only the category it implied is wrong. Each entry is a naming convention the
 * manufacturer applies consistently to a whole family, which is why matching on the model prefix is
 * safe where a generic text rule is not.
 */

import type { ClassifiableCategoryId, KnowledgeSourceCandidate } from "../../../types.js";
import type { KnowledgeSourceVerification } from "../../../types.js";

interface ModelFamily {
  manufacturerId: string;
  /** Matched against the NFKC-normalized, upper-cased model. */
  pattern: RegExp;
  categoryId: ClassifiableCategoryId;
  reason: string;
}

const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze([
  {
    manufacturerId: "stax",
    pattern: /^SRM(?:[-\s]|\d)/,
    categoryId: "headphone_amp",
    // STAX SRM units drive electrostatic headphones. Some advertise their built-in DAC more
    // prominently than the amplifier role, so generic text classification chooses DAC.
    reason: "electrostatic_driver_unit",
  },
  {
    manufacturerId: "mcintosh",
    pattern: /^MHA(?:[-\s]|\d)/,
    categoryId: "headphone_amp",
    // McIntosh MHA is the dedicated headphone-amplifier family. Titles read "Headphone Power
    // Amplifier", which a generic power-amplifier rule matches too broadly.
    reason: "dedicated_headphone_amplifier_family",
  },
]);

function familyCategory(candidate: KnowledgeSourceCandidate = {}): ClassifiableCategoryId | "" {
  const manufacturerId = String(candidate.manufacturerId || "")
    .trim()
    .toLowerCase();
  const model = String(
    candidate.canonicalModel ||
      candidate.observedModel ||
      candidate.model ||
      candidate.normalizedModel ||
      "",
  )
    .normalize("NFKC")
    .trim()
    .toUpperCase();
  const family = MODEL_FAMILIES.find(
    (entry) => entry.manufacturerId === manufacturerId && entry.pattern.test(model),
  );
  return family?.categoryId || "";
}

/**
 * Replaces a verified result's category when the model belongs to a known family.
 *
 * The message suffix is persisted and read back by operational status, so it is kept verbatim.
 */
export function applyOfficialFamilyCategory(
  result: KnowledgeSourceVerification,
  candidate: KnowledgeSourceCandidate,
): KnowledgeSourceVerification {
  if (result?.status !== "verified") return result;
  const categoryId = familyCategory(candidate);
  if (!categoryId) return result;
  return {
    ...result,
    categoryIds: [categoryId],
    primaryCategoryId: categoryId,
    message: `${result.message || "verified"}:official_family_v5`,
  };
}
