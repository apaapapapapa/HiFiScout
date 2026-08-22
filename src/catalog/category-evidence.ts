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
  "cartridge",
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
  // Broad seller buckets such as "speaker", "accessory" or the parent "cartridge" are useful
  // fallback evidence, but must not override a more specific explicit title such as headshell.
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
  const evidence = [
    ...sellerCategoryEvidence(rawCategory, categoryMapping, policy),
    ...categoryEvidenceFromText(title, { source: "title", strength: "strong", context: "title" }),
  ];
  if (!rawCategory) evidence.push(...parserHintEvidence(hintedCategory, policy));
  return { evidence, policy };
}
