import type {
  IdentityCandidateInput,
  IdentityListingInput,
  IdentityMatchedField,
  IdentityMatchMethod,
  IdentityModelParts,
  IdentityVeto,
  ProductIdentityResolution,
} from "./types.js";
import {
  categoryIdForClassification,
  isUnclassifiedCategoryId,
} from "./categories.js";

const ROMAN_TO_NUMBER: Readonly<Record<string, string>> = Object.freeze({
  I: "1",
  II: "2",
  III: "3",
  IV: "4",
});
const NUMBER_TO_ROMAN: Readonly<Record<string, string>> = Object.freeze({
  1: "I",
  2: "II",
  3: "III",
  4: "IV",
});
const WORD_VARIANTS = Object.freeze([
  "LIMITEDEDITION",
  "SIGNATURE",
  "ANNIVERSARY",
  "REFERENCE",
  "LIMITED",
  "META",
  "PRO",
  "TX",
  "SE",
]);

interface TrailingVariant {
  token: string;
  length: number;
}

interface IdentityCandidateView extends IdentityCandidateInput {
  manufacturerId: string;
  canonicalModel: string;
  parts: IdentityModelParts;
  aliasParts: { alias: string; parts: IdentityModelParts }[];
}

interface RejectedIdentityCandidate {
  candidateId: number;
  rule: "variant_mismatch";
}

interface FuzzyIdentityCandidate {
  candidate: IdentityCandidateView;
  distance: number;
  maxLength: number;
}

function clean(value: unknown = ""): string {
  return String(value)
    .normalize("NFKC")
    .replace(/[‐‑‒–—―－]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalizeRevisionMarkers(value: string): string {
  return value
    .replace(
      /\bMARK\s*(IV|III|II|I|[1-9]\d*)\b/giu,
      (_, revision) => `MK${ROMAN_TO_NUMBER[revision.toUpperCase()] || revision}`,
    )
    .replace(
      /\bMK\s*(IV|III|II|I|[1-9]\d*)\b/giu,
      (_, revision) => `MK${ROMAN_TO_NUMBER[revision.toUpperCase()] || revision}`,
    )
    .replace(
      /MK(IV|III|II|I)(?=$|[^A-Z])/giu,
      (_, revision) => `MK${ROMAN_TO_NUMBER[revision.toUpperCase()]}`,
    )
    .replace(
      /MK(IV|III|II|I)(?=[A-Z0-9])/giu,
      (_, revision) => `MK${ROMAN_TO_NUMBER[revision.toUpperCase()]}`,
    )
    .replace(/\bLIMITED\s+EDITION\b/giu, "LIMITED");
}

function canonicalizeStandaloneRomanSuffix(value: string): string {
  return value.replace(
    /(?:^|[\s/_-])(IV|III|II)(?=$|[\s/_-])/giu,
    (_, revision) => ` REV${ROMAN_TO_NUMBER[revision.toUpperCase()]}`,
  );
}

export function normalizeIdentityModel(value: unknown = ""): string {
  const normalized = canonicalizeStandaloneRomanSuffix(
    canonicalizeRevisionMarkers(clean(value).toUpperCase()),
  );
  return normalized.replace(/[^A-Z0-9]+/gu, "");
}

function trailingVariant(normalizedModel: string): TrailingVariant | null {
  const model = normalizedModel || "";
  const mk = model.match(/MK([1-9]\d*)$/u);
  if (mk && model.length > mk[0].length) return { token: `MK${mk[1]}`, length: mk[0].length };

  const revision = model.match(/REV([2-4])$/u);
  if (revision && model.length > revision[0].length) {
    return { token: `REV${revision[1]}`, length: revision[0].length };
  }

  for (const suffix of WORD_VARIANTS) {
    if (!model.endsWith(suffix) || model.length <= suffix.length) continue;
    const stem = model.slice(0, -suffix.length);
    if (!/\d/u.test(stem)) continue;
    return {
      token: suffix === "LIMITEDEDITION" ? "LIMITED" : suffix,
      length: suffix.length,
    };
  }

  if (model.endsWith("X") && model.length > 1) {
    const stem = model.slice(0, -1);
    if (/\d/u.test(stem)) return { token: "X", length: 1 };
  }
  return null;
}

export function identityModelParts(value: unknown = ""): IdentityModelParts {
  const normalizedModel = normalizeIdentityModel(value);
  if (!normalizedModel) return { normalizedModel: "", modelStem: "", variants: [] };

  let stem = normalizedModel;
  const variants: string[] = [];
  for (;;) {
    const variant = trailingVariant(stem);
    if (!variant) break;
    variants.unshift(variant.token);
    stem = stem.slice(0, -variant.length);
  }

  return {
    normalizedModel,
    modelStem: stem || normalizedModel,
    variants: [...new Set(variants)],
  };
}

function sameVariants(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function identityVeto(leftModel: unknown, rightModel: unknown): IdentityVeto | null {
  const left = identityModelParts(leftModel);
  const right = identityModelParts(rightModel);
  if (!left.normalizedModel || !right.normalizedModel) return null;
  if (left.modelStem !== right.modelStem) return null;
  if (!sameVariants(left.variants, right.variants)) {
    return {
      rule: "variant_mismatch",
      leftVariants: left.variants,
      rightVariants: right.variants,
    };
  }
  return null;
}

function canonicalVariantText(token: string, roman = false): string {
  if (token.startsWith("MK")) {
    const number = token.slice(2);
    return roman && NUMBER_TO_ROMAN[number] ? `MK${NUMBER_TO_ROMAN[number]}` : `MK${number}`;
  }
  if (token.startsWith("REV")) {
    const number = token.slice(3);
    return roman && NUMBER_TO_ROMAN[number] ? NUMBER_TO_ROMAN[number] : number;
  }
  if (token === "LIMITED") return roman ? "LIMITED EDITION" : "LIMITED";
  return token;
}

function hyphenateLeadingModel(value: string): string {
  const match = value.match(/^([A-Z]{1,4})(\d.*)$/u);
  return match ? `${match[1]}-${match[2]}` : "";
}

export function buildModelSearchAliases(value: unknown = ""): string[] {
  const original = clean(value).toUpperCase();
  const parts = identityModelParts(value);
  if (!parts.normalizedModel) return [];

  const aliases = new Set([original, parts.normalizedModel]);
  const variant = parts.variants.length
    ? parts.variants.map((token) => canonicalVariantText(token)).join(" ")
    : "";
  const romanVariant = parts.variants.length
    ? parts.variants.map((token) => canonicalVariantText(token, true)).join(" ")
    : "";

  if (variant) aliases.add(`${parts.modelStem} ${variant}`);
  if (romanVariant && romanVariant !== variant) {
    aliases.add(`${parts.modelStem} ${romanVariant}`);
    aliases.add(`${parts.modelStem}${romanVariant.replaceAll(" ", "")}`);
  }

  const hyphenatedStem = hyphenateLeadingModel(parts.modelStem);
  if (hyphenatedStem) {
    aliases.add(variant ? `${hyphenatedStem} ${variant}` : hyphenatedStem);
    if (romanVariant && romanVariant !== variant) aliases.add(`${hyphenatedStem} ${romanVariant}`);
  }

  return [...aliases]
    .map((item) => clean(item))
    .filter(Boolean)
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, 8);
}

function levenshteinDistance(
  left: string,
  right: string,
  maxDistance = Number.POSITIVE_INFINITY,
): number {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length];
}

function categoryCompatible(
  product: IdentityListingInput,
  candidate: IdentityCandidateView,
): boolean {
  const listingCategory = product.primaryCategoryId || product.primary_category_id || "";
  const candidateCategories = candidate.categoryIds || candidate.category_ids || [];
  const canonicalListingCategory = categoryIdForClassification(listingCategory);
  if (
    !canonicalListingCategory ||
    isUnclassifiedCategoryId(canonicalListingCategory) ||
    !candidateCategories.length
  ) {
    return true;
  }
  return candidateCategories.some(
    (categoryId) => categoryIdForClassification(categoryId) === canonicalListingCategory,
  );
}

function candidateView(candidate: IdentityCandidateInput): IdentityCandidateView {
  const canonicalModel =
    candidate.canonicalModel || candidate.canonical_model || candidate.model || "";
  const aliases = candidate.aliases || [];
  return {
    ...candidate,
    id: candidate.id,
    manufacturerId: candidate.manufacturerId || candidate.manufacturer_id || "",
    canonicalModel,
    parts: identityModelParts(canonicalModel),
    aliasParts: aliases.map((alias) => ({ alias, parts: identityModelParts(alias) })),
  };
}

function matchedResolution(
  productParts: IdentityModelParts,
  candidate: IdentityCandidateView,
  matchMethod: Extract<IdentityMatchMethod, "manufacturer_model_exact" | "catalog_alias">,
  matchedAlias = "",
): ProductIdentityResolution {
  const fields: IdentityMatchedField[] = ["manufacturer_id", "normalized_model"];
  if (matchedAlias) fields.push("catalog_alias");
  return {
    status: "matched",
    catalogProductId: candidate.id,
    candidateCatalogProductId: candidate.id,
    matchMethod,
    confidence: "high",
    normalizedModel: productParts.normalizedModel,
    modelStem: productParts.modelStem,
    variants: productParts.variants,
    matchedFields: fields,
    rejectedBy: [],
    matchedAlias,
  };
}

export function resolveProductIdentity(
  product: IdentityListingInput,
  candidates: readonly IdentityCandidateInput[] = [],
): ProductIdentityResolution {
  const manufacturerId = String(product.manufacturerId || product.manufacturer_id || "")
    .trim()
    .toLowerCase();
  const model = product.model || "";
  const parts = identityModelParts(model);
  if (!manufacturerId || !parts.normalizedModel) {
    return {
      status: "unresolved",
      catalogProductId: null,
      candidateCatalogProductId: null,
      matchMethod: "unresolved",
      confidence: "none",
      normalizedModel: parts.normalizedModel,
      modelStem: parts.modelStem,
      variants: parts.variants,
      matchedFields: manufacturerId ? ["manufacturer_id"] : [],
      rejectedBy: ["missing_identity_fields"],
      matchedAlias: "",
    };
  }

  // A model Model Resolution could not fully classify must not attach to a canonical product.
  // Normalization strips exactly the residue that made it a candidate — `D-1000 MK2 特別仕様`
  // normalizes to `D1000MK2` — so without this gate an unclassified edition would exact-match the
  // base product at high confidence. The listing stays unresolved and remediable instead.
  const modelStatus = product.modelResolutionStatus || product.model_resolution_status;
  if (modelStatus && modelStatus !== "resolved") {
    return {
      status: "unresolved",
      catalogProductId: null,
      candidateCatalogProductId: null,
      matchMethod: "unresolved",
      confidence: "none",
      normalizedModel: parts.normalizedModel,
      modelStem: parts.modelStem,
      variants: parts.variants,
      matchedFields: ["manufacturer_id"],
      rejectedBy: ["unresolved_model"],
      matchedAlias: "",
    };
  }

  const manufacturerCandidates = candidates
    .map(candidateView)
    .filter((candidate) => candidate.manufacturerId === manufacturerId);

  const rejected: RejectedIdentityCandidate[] = [];
  const exactMatches: IdentityCandidateView[] = [];
  for (const candidate of manufacturerCandidates) {
    if (candidate.parts.normalizedModel !== parts.normalizedModel) continue;
    const veto = identityVeto(model, candidate.canonicalModel);
    if (veto) {
      rejected.push({ candidateId: candidate.id, rule: veto.rule });
      continue;
    }
    exactMatches.push(candidate);
  }
  if (exactMatches.length === 1) {
    return matchedResolution(parts, exactMatches[0], "manufacturer_model_exact");
  }
  if (exactMatches.length > 1) {
    return {
      status: "unresolved",
      catalogProductId: null,
      candidateCatalogProductId: null,
      matchMethod: "exact_ambiguous",
      confidence: "none",
      normalizedModel: parts.normalizedModel,
      modelStem: parts.modelStem,
      variants: parts.variants,
      matchedFields: ["manufacturer_id", "normalized_model"],
      rejectedBy: ["ambiguous_candidates"],
      matchedAlias: "",
    };
  }

  const aliasMatches: { candidate: IdentityCandidateView; alias: string }[] = [];
  for (const candidate of manufacturerCandidates) {
    const matchedAlias = candidate.aliasParts.find(
      (alias) =>
        alias.parts.normalizedModel && alias.parts.normalizedModel === parts.normalizedModel,
    );
    if (!matchedAlias) continue;
    const veto = identityVeto(model, candidate.canonicalModel);
    if (veto) {
      rejected.push({ candidateId: candidate.id, rule: veto.rule });
      continue;
    }
    aliasMatches.push({ candidate, alias: matchedAlias.alias });
  }
  if (aliasMatches.length === 1) {
    return matchedResolution(
      parts,
      aliasMatches[0].candidate,
      "catalog_alias",
      aliasMatches[0].alias,
    );
  }
  if (aliasMatches.length > 1) {
    return {
      status: "unresolved",
      catalogProductId: null,
      candidateCatalogProductId: null,
      matchMethod: "alias_ambiguous",
      confidence: "none",
      normalizedModel: parts.normalizedModel,
      modelStem: parts.modelStem,
      variants: parts.variants,
      matchedFields: ["manufacturer_id"],
      rejectedBy: ["ambiguous_candidates"],
      matchedAlias: "",
    };
  }

  const sameStem = manufacturerCandidates.filter(
    (candidate) => candidate.parts.modelStem === parts.modelStem,
  );
  for (const candidate of sameStem) {
    const veto = identityVeto(model, candidate.canonicalModel);
    if (veto) rejected.push({ candidateId: candidate.id, rule: veto.rule });
  }
  if (rejected.length) {
    return {
      status: "unresolved",
      catalogProductId: null,
      candidateCatalogProductId: rejected[0].candidateId,
      matchMethod: "vetoed",
      confidence: "none",
      normalizedModel: parts.normalizedModel,
      modelStem: parts.modelStem,
      variants: parts.variants,
      matchedFields: ["manufacturer_id", "model_stem"],
      rejectedBy: [...new Set(rejected.map((item) => item.rule))],
      matchedAlias: "",
    };
  }

  const fuzzyCandidates = manufacturerCandidates
    .filter(
      (candidate) => candidate.parts.normalizedModel && categoryCompatible(product, candidate),
    )
    .map((candidate) => {
      const veto = identityVeto(model, candidate.canonicalModel);
      if (veto) return null;
      const maxLength = Math.max(
        parts.normalizedModel.length,
        candidate.parts.normalizedModel.length,
      );
      const maxDistance = maxLength >= 8 ? 1 : 0;
      const distance = levenshteinDistance(
        parts.normalizedModel,
        candidate.parts.normalizedModel,
        maxDistance,
      );
      return distance <= maxDistance ? { candidate, distance, maxLength } : null;
    })
    .filter((candidate): candidate is FuzzyIdentityCandidate => candidate !== null)
    .sort(
      (left, right) => left.distance - right.distance || left.candidate.id - right.candidate.id,
    );

  if (fuzzyCandidates.length === 1) {
    const candidate = fuzzyCandidates[0].candidate;
    return {
      status: "unresolved",
      catalogProductId: null,
      candidateCatalogProductId: candidate.id,
      matchMethod: "fuzzy_candidate",
      confidence: "low",
      normalizedModel: parts.normalizedModel,
      modelStem: parts.modelStem,
      variants: parts.variants,
      matchedFields: ["manufacturer_id"],
      rejectedBy: [],
      matchedAlias: "",
    };
  }

  return {
    status: "unresolved",
    catalogProductId: null,
    candidateCatalogProductId: fuzzyCandidates[0]?.candidate.id || null,
    matchMethod: fuzzyCandidates.length > 1 ? "fuzzy_ambiguous" : "unresolved",
    confidence: "none",
    normalizedModel: parts.normalizedModel,
    modelStem: parts.modelStem,
    variants: parts.variants,
    matchedFields: ["manufacturer_id"],
    rejectedBy: fuzzyCandidates.length > 1 ? ["ambiguous_candidates"] : [],
    matchedAlias: "",
  };
}
