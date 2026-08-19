import { normalizeCategory } from "./categories.js";
import { inferExplicitCategoryIds } from "./category-rules.js";
import type {
  CategoryPolicyInput,
  CategoryEvidenceInput,
  CategoryEvidenceStrength,
  CategoryMapping,
  CategoryPolicyMode,
  CollectListingCategoryEvidenceOptions,
  ListingCategoryEvidence,
  NormalizeCategoryResult,
  ResolvedCategoryPolicy,
} from "./types.js";

const BROAD_SELLER_CATEGORY_IDS: ReadonlySet<string> = new Set([
  "other",
  "other_accessory",
  "cable_other",
  "wired_headphone",
  "wired_earphone",
  "clean_power",
]);

// These leaves are intentionally broad but still semantically exact when a shop explicitly maps
// its own seller bucket to them. They may be used as a last-resort classification only when no
// stronger title evidence exists. Keep this list narrower than BROAD_SELLER_CATEGORY_IDS: a
// generic headphone bucket, for example, cannot safely choose wired vs wireless.
const SAFE_MAPPED_BROAD_FALLBACK_IDS: ReadonlySet<string> = new Set([
  "other_accessory",
  "cable_other",
]);

// The remediation replay reconstructs category evidence from persisted listing fields without
// importing concrete crawler adapters. These exact raw seller labels are unambiguous enough to
// reproduce the same safe fallback even when the original shop mapping is not available.
const SAFE_RAW_BROAD_FALLBACK_IDS: ReadonlyMap<string, string> = new Map([
  ["アクセサリー", "other_accessory"],
  ["ケーブル", "cable_other"],
]);

function mode(value: unknown, fallback: CategoryPolicyMode): CategoryPolicyMode {
  return value === "authoritative" || value === "corroborative" || value === "ignore"
    ? value
    : fallback;
}

function strengthForMode(value: CategoryPolicyMode): CategoryEvidenceStrength | null {
  if (value === "authoritative") return "authoritative";
  if (value === "corroborative") return "supporting";
  return null;
}

export function resolveCategoryPolicy(requested: CategoryPolicyInput = {}): ResolvedCategoryPolicy {
  const seller = requested.sellerCategory || {};
  return {
    sellerCategory: {
      default: mode(seller.default, "authoritative"),
      categories: { ...seller.categories },
    },
    // Parser output is a hint, never stronger than an explicit product title.
    parserHint: mode(requested.parserHint, "corroborative"),
    enrichment: {
      maxRequestsPerCrawl: Math.max(0, Number(requested.enrichment?.maxRequestsPerCrawl) || 0),
      cacheHours: Math.max(1, Number(requested.enrichment?.cacheHours) || 168),
    },
  };
}

export function categoryEvidenceFromText(
  text: string,
  {
    source = "title",
    strength = "strong",
    context = "title",
  }: { source?: string; strength?: CategoryEvidenceStrength; context?: string } = {},
): CategoryEvidenceInput[] {
  const categoryIds = inferExplicitCategoryIds(text, { context });
  return categoryIds.length
    ? [{ categoryIds: [categoryIds[0]], source, strength, value: String(text || "") }]
    : [];
}

function sellerCategoryCandidates(
  rawCategory: string,
  categoryMapping: CategoryMapping,
): NormalizeCategoryResult | null {
  if (!rawCategory) return null;
  const normalized = normalizeCategory({ rawCategory, categoryMapping });
  if (normalized.classificationStatus === "classified") return normalized;
  const inferred = inferExplicitCategoryIds(rawCategory, { context: "seller" });
  if (!inferred.length) return null;
  return {
    ...normalized,
    primaryCategoryId: inferred[0],
    categoryIds: [inferred[0]],
    classificationStatus: "classified",
    classificationSource: "raw_inference",
  };
}

export function sellerCategoryEvidence(
  rawCategory: string,
  categoryMapping: CategoryMapping,
  policy: ResolvedCategoryPolicy,
): CategoryEvidenceInput[] {
  const normalized = sellerCategoryCandidates(rawCategory, categoryMapping);
  if (!normalized) return [];
  // Broad seller buckets such as "speaker" or "accessory" are useful fallback evidence,
  // but must not override a more specific explicit title such as bookshelf speaker or cable.
  const inferredBroadLabel =
    normalized.classificationSource === "raw_inference" ||
    BROAD_SELLER_CATEGORY_IDS.has(normalized.primaryCategoryId);
  const fallbackMode = inferredBroadLabel ? "corroborative" : policy.sellerCategory.default;
  const categoryId = normalized.primaryCategoryId;
  const requestedMode = mode(policy.sellerCategory.categories?.[categoryId], fallbackMode);
  const strength = strengthForMode(requestedMode);
  return strength
    ? [
        {
          categoryIds: [categoryId],
          source: "seller_category",
          strength,
          value: String(rawCategory),
        },
      ]
    : [];
}

function safeMappedBroadFallbackId(
  rawCategory: string,
  categoryMapping: CategoryMapping,
  policy: ResolvedCategoryPolicy,
): string | null {
  if (!rawCategory || policy.sellerCategory.default !== "authoritative") return null;

  const exactRawFallback = SAFE_RAW_BROAD_FALLBACK_IDS.get(rawCategory.normalize("NFKC").trim());
  if (exactRawFallback) {
    // An explicit per-category policy always wins over the automatic fallback promotion.
    return policy.sellerCategory.categories?.[exactRawFallback] == null ? exactRawFallback : null;
  }

  const directMapping = categoryMapping[rawCategory];
  // Array mappings intentionally represent broad/mixed seller buckets; never force one member.
  if (typeof directMapping !== "string") return null;
  const normalized = normalizeCategory({ rawCategory, categoryMapping });
  if (
    normalized.classificationStatus !== "classified" ||
    normalized.classificationSource !== "shop_mapping" ||
    !SAFE_MAPPED_BROAD_FALLBACK_IDS.has(normalized.primaryCategoryId)
  ) {
    return null;
  }
  // An explicit per-category policy always wins over this automatic fallback promotion.
  if (policy.sellerCategory.categories?.[normalized.primaryCategoryId] != null) return null;
  return normalized.primaryCategoryId;
}

export function parserHintEvidence(
  hintedCategory: string,
  policy: ResolvedCategoryPolicy,
): CategoryEvidenceInput[] {
  if (!hintedCategory || policy.parserHint === "ignore") return [];
  const normalized = normalizeCategory({ hintedCategory });
  const categoryIds =
    normalized.classificationStatus === "classified"
      ? normalized.categoryIds
      : inferExplicitCategoryIds(hintedCategory, { context: "hint" });
  if (!categoryIds.length || categoryIds[0] === "other") return [];
  const strength = strengthForMode(policy.parserHint);
  return strength
    ? [
        {
          categoryIds: [categoryIds[0]],
          source: "parser_hint",
          strength,
          value: String(hintedCategory),
        },
      ]
    : [];
}

export function collectListingCategoryEvidence({
  title = "",
  rawCategory = "",
  hintedCategory = "",
  categoryMapping = {},
  categoryPolicy = {},
}: CollectListingCategoryEvidenceOptions = {}): ListingCategoryEvidence {
  const policy = resolveCategoryPolicy(categoryPolicy);
  let sellerEvidence = sellerCategoryEvidence(rawCategory, categoryMapping, policy);
  const titleEvidence = categoryEvidenceFromText(title, {
    source: "title",
    strength: "strong",
    context: "title",
  });

  // An exact safe seller bucket can resolve a model-only listing, but only after confirming the
  // title gives us no more specific category. This is intentionally not a general promotion of
  // corroborative evidence.
  const fallbackId =
    titleEvidence.length === 0
      ? safeMappedBroadFallbackId(rawCategory, categoryMapping, policy)
      : null;
  if (fallbackId && sellerEvidence.length) {
    sellerEvidence = sellerEvidence.map((item) =>
      item.categoryIds?.[0] === fallbackId ? { ...item, strength: "authoritative" } : item,
    );
  }

  const evidence = [...sellerEvidence, ...titleEvidence];
  if (!rawCategory) evidence.push(...parserHintEvidence(hintedCategory, policy));
  return { evidence, policy };
}
