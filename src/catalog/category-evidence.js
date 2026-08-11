import { normalizeCategory } from './categories.js';
import { inferExplicitCategoryIds } from './category-rules.js';

const MODES = new Set(['authoritative', 'corroborative', 'ignore']);
const BROAD_SELLER_CATEGORY_IDS = new Set(['speaker_other', 'other_accessory']);

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
    // Parser output is a hint, never stronger than an explicit product title.
    parserHint: mode(requested.parserHint, 'corroborative'),
    enrichment: {
      maxRequestsPerCrawl: Math.max(0, Number(requested.enrichment?.maxRequestsPerCrawl) || 0),
      cacheHours: Math.max(1, Number(requested.enrichment?.cacheHours) || 168)
    }
  };
}

export function categoryEvidenceFromText(text, { source = 'title', strength = 'strong', context = 'title' } = {}) {
  const categoryIds = inferExplicitCategoryIds(text, { context });
  return categoryIds.length ? [{ categoryIds: [categoryIds[0]], source, strength, value: String(text || '') }] : [];
}

function sellerCategoryCandidates(rawCategory, categoryMapping) {
  if (!rawCategory) return null;
  const normalized = normalizeCategory({ rawCategory, categoryMapping });
  if (normalized.classificationStatus === 'classified') return normalized;
  const inferred = inferExplicitCategoryIds(rawCategory, { context: 'seller' });
  if (!inferred.length) return null;
  return { ...normalized, primaryCategoryId: inferred[0], categoryIds: [inferred[0]], classificationStatus: 'classified', classificationSource: 'raw_inference' };
}

export function sellerCategoryEvidence(rawCategory, categoryMapping, policy) {
  const normalized = sellerCategoryCandidates(rawCategory, categoryMapping);
  if (!normalized) return [];
  // Broad seller buckets such as "speaker" or "accessory" are useful fallback evidence,
  // but must not override a more specific explicit title such as bookshelf speaker or cable.
  const inferredBroadLabel = normalized.classificationSource === 'raw_inference' || BROAD_SELLER_CATEGORY_IDS.has(normalized.primaryCategoryId);
  const fallbackMode = inferredBroadLabel ? 'corroborative' : policy.sellerCategory.default;
  const categoryId = normalized.primaryCategoryId;
  const requestedMode = mode(policy.sellerCategory.categories?.[categoryId], fallbackMode);
  const strength = strengthForMode(requestedMode);
  return strength ? [{ categoryIds: [categoryId], source: 'seller_category', strength, value: String(rawCategory) }] : [];
}

export function parserHintEvidence(hintedCategory, policy) {
  if (!hintedCategory || policy.parserHint === 'ignore') return [];
  const normalized = normalizeCategory({ hintedCategory });
  const categoryIds = normalized.classificationStatus === 'classified'
    ? normalized.categoryIds
    : inferExplicitCategoryIds(hintedCategory, { context: 'hint' });
  if (!categoryIds.length || categoryIds[0] === 'other') return [];
  const strength = strengthForMode(policy.parserHint);
  return strength ? [{ categoryIds: [categoryIds[0]], source: 'parser_hint', strength, value: String(hintedCategory) }] : [];
}

export function collectListingCategoryEvidence({ title = '', rawCategory = '', hintedCategory = '', categoryMapping = {}, adapter = {} } = {}) {
  const policy = resolveCategoryPolicy(adapter);
  const evidence = [
    ...sellerCategoryEvidence(rawCategory, categoryMapping, policy),
    ...categoryEvidenceFromText(title, { source: 'title', strength: 'strong', context: 'title' })
  ];
  if (!rawCategory) evidence.push(...parserHintEvidence(hintedCategory, policy));
  return { evidence, policy };
}
