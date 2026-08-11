import { categorySearchAliases, getCategory } from './categories.js';

const STRENGTHS = new Set(['verified', 'authoritative', 'strong', 'supporting']);

function validCategoryIds(values = []) {
  return [...new Set(values)].filter(id => getCategory(id)?.selectable);
}

function normalizedEvidence(evidence = []) {
  return evidence
    .map(item => ({
      categoryIds: validCategoryIds(item?.categoryIds || (item?.categoryId ? [item.categoryId] : [])),
      source: String(item?.source || 'unknown'),
      strength: STRENGTHS.has(item?.strength) ? item.strength : 'supporting',
      value: String(item?.value || '').slice(0, 240)
    }))
    .filter(item => item.categoryIds.length);
}

function isSubset(left, right) {
  const rightSet = new Set(right);
  return left.every(value => rightSet.has(value));
}

function compatibleCategorySet(items) {
  if (!items.length) return null;
  const candidates = [...items].sort((left, right) => right.categoryIds.length - left.categoryIds.length);
  return candidates.find(candidate => items.every(item => isSubset(item.categoryIds, candidate.categoryIds))) || null;
}

function unresolved(state, evidence) {
  const candidateCategoryIds = validCategoryIds(evidence.flatMap(item => item.categoryIds));
  return {
    primaryCategoryId: 'other',
    categoryIds: [],
    displayName: '未分類',
    classificationStatus: 'unclassified',
    classificationState: state,
    classificationReason: state === 'ambiguous' ? 'conflicting_evidence' : 'insufficient_evidence',
    classificationSource: state,
    candidateCategoryIds,
    searchAliases: ''
  };
}

function classified(candidate, tierEvidence) {
  const categoryIds = candidate.categoryIds;
  const primary = getCategory(categoryIds[0]);
  const sources = [...new Set(tierEvidence
    .filter(item => isSubset(item.categoryIds, categoryIds))
    .map(item => item.source))];
  return {
    primaryCategoryId: primary?.id || 'other',
    categoryIds,
    displayName: primary?.name || 'その他',
    classificationStatus: 'classified',
    classificationState: 'classified',
    classificationReason: '',
    classificationSource: sources.join('+') || 'classified',
    candidateCategoryIds: [],
    searchAliases: categorySearchAliases(categoryIds)
  };
}

export function classifyCategoryEvidence(rawEvidence = []) {
  const evidence = normalizedEvidence(rawEvidence);

  for (const strength of ['verified', 'authoritative', 'strong']) {
    const tier = evidence.filter(item => item.strength === strength);
    if (!tier.length) continue;
    const candidate = compatibleCategorySet(tier);
    if (!candidate) return unresolved('ambiguous', tier);
    return classified(candidate, tier);
  }

  return unresolved('unclassified', evidence);
}

export function summarizeCategoryEvidence(rawEvidence = []) {
  return normalizedEvidence(rawEvidence).slice(0, 12).map(item => ({
    categoryIds: item.categoryIds,
    source: item.source,
    strength: item.strength,
    value: item.value.slice(0, 160)
  }));
}
