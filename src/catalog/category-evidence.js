import { normalizeCategory } from './categories.js';
import { inferExplicitCategoryIds } from './category-rules.js';

const MODES = new Set(['authoritative', 'corroborative', 'ignore']);

function mode(value, fallback) {
  return MODES.has(value) ? value : fallback;
}

function strengthForMode(value) {
  if (value === 'authoritative') return 'authoritative';
  if (value === 'corroborative') return 'supporting';
  return null;
}

export function resolveCategoryPolicy(adapter = {}) {
  const requested = adapter.categoryPolicy || {};
  const seller = requested.sellerCategory || {};
  const legacyPrefer = requested.titleInference === 'prefer';
  return {
    sellerCategory: {
      default: mode(seller.default, legacyPrefer ? 'corroborative' : 'authoritative'),
      categories: { ...(seller.categories || {}) }
    },
    parserHint: mode(requested.parserHint, legacyPrefer ? 'corroborative' : 'authoritative'),
    enrichment: {
      maxRequestsPerCrawl: Math.max(0, Number(requested.enrichment?.maxRequestsPerCrawl) || 0),
      cacheHours: Math.max(1, Number(requested.enrichment?.cacheHours) || 168)
    }
  };
}

export function categoryEvidenceFromText(text, {
  source = 'title',
  strength = 'strong',
  context = 'title'
} = {}) {
  const categoryIds = inferExplicitCategoryIds(text, { context });
  if (!categoryIds.length) return [];
  return [{ categoryIds, source, strength, value: String(text || '') }];
}

function sellerCategoryCandidates(rawCategory, categoryMapping) {
  if (!rawCategory) return null;
  const normalized = normalizeCategory({ rawCategory, categoryMapping });
  if (normalized.classificationStatus !== 'classified') return null;
  return normalized;
}

export function sellerCategoryEvidence(rawCategory, categoryMapping, policy) {
  const normalized = sellerCategoryCandidates(rawCategory, categoryMapping);
  if (!normalized) return [];

  // Free-text inference from a broad seller label is never authoritative by itself.
  const inferredBroadLabel = normalized.classificationSource === 'raw_inference';
  const fallbackMode = inferredBroadLabel ? 'corroborative' : policy.sellerCategory.default;
  const groups = new Map();

  for (const categoryId of normalized.categoryIds) {
    const requestedMode = mode(policy.sellerCategory.categories?.[categoryId], fallbackMode);
    const strength = strengthForMode(requestedMode);
    if (!strength) continue;
    if (!groups.has(strength)) groups.set(strength, []);
    groups.get(strength).push(categoryId);
  }

  return [...groups.entries()].map(([strength, categoryIds]) => ({
    categoryIds,
    source: 'seller_category',
    strength,
    value: String(rawCategory)
  }));
}

export function parserHintEvidence(hintedCategory, policy) {
  if (!hintedCategory || policy.parserHint === 'ignore') return [];
  const normalized = normalizeCategory({ hintedCategory });
  if (normalized.classificationStatus !== 'classified') return [];
  // The legacy parser uses "その他" as its unknown sentinel. It is not evidence that
  // the seller deliberately classified the item as the canonical "other" category.
  if (normalized.primaryCategoryId === 'other') return [];
  const strength = strengthForMode(policy.parserHint);
  return strength ? [{
    categoryIds: normalized.categoryIds,
    source: 'parser_hint',
    strength,
    value: String(hintedCategory)
  }] : [];
}

export function collectListingCategoryEvidence({
  title = '', rawCategory = '', hintedCategory = '', categoryMapping = {}, adapter = {}
} = {}) {
  const policy = resolveCategoryPolicy(adapter);
  const evidence = [
    ...sellerCategoryEvidence(rawCategory, categoryMapping, policy),
    ...categoryEvidenceFromText(title, { source: 'title', strength: 'strong', context: 'title' })
  ];
  if (!rawCategory) evidence.push(...parserHintEvidence(hintedCategory, policy));
  return { evidence, policy };
}
