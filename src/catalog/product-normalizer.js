import { classifyCategoryEvidence, summarizeCategoryEvidence } from './category-classifier.js';
import { collectListingCategoryEvidence } from './category-evidence.js';
import { normalizeManufacturer } from './manufacturers.js';

const CLASSIFICATION_METADATA_VERSION = 3;

function clean(value = '') {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function classificationMetadata(classification, evidence, existing = {}) {
  return {
    ...existing,
    version: CLASSIFICATION_METADATA_VERSION,
    state: classification.classificationState,
    status: classification.classificationStatus,
    reason: classification.classificationReason,
    source: classification.classificationSource,
    categoryIds: classification.categoryIds,
    candidateCategoryIds: classification.candidateCategoryIds,
    evidence: summarizeCategoryEvidence(evidence)
  };
}

export function applyCategoryClassification(product, classification, evidence = product.categoryEvidence || [], metadataPatch = {}) {
  const metadata = product.metadata && typeof product.metadata === 'object' && !Array.isArray(product.metadata)
    ? product.metadata
    : {};
  const previousClassification = metadata.categoryClassification && typeof metadata.categoryClassification === 'object'
    ? metadata.categoryClassification
    : {};

  return {
    ...product,
    primaryCategoryId: classification.primaryCategoryId,
    categoryIds: classification.categoryIds,
    category: classification.displayName,
    classificationStatus: classification.classificationStatus,
    classificationState: classification.classificationState,
    classificationReason: classification.classificationReason,
    classificationSource: classification.classificationSource,
    candidateCategoryIds: classification.candidateCategoryIds,
    searchAliases: classification.searchAliases,
    categoryEvidence: evidence,
    metadata: {
      ...metadata,
      categoryClassification: classificationMetadata(classification, evidence, {
        ...previousClassification,
        ...metadataPatch
      })
    }
  };
}

export function normalizeCatalogProduct(product, adapter = {}) {
  const rawManufacturer = clean(product.rawManufacturer ?? product.manufacturer ?? '');
  const manufacturerCandidate = clean(product.manufacturer || rawManufacturer);
  const rawCategory = clean(product.rawCategory ?? '');
  const manufacturer = normalizeManufacturer(manufacturerCandidate);
  const { evidence } = collectListingCategoryEvidence({
    rawCategory,
    title: product.title || '',
    hintedCategory: product.category || '',
    categoryMapping: adapter.categoryMapping || {},
    adapter
  });
  const classification = classifyCategoryEvidence(evidence);

  return applyCategoryClassification({
    ...product,
    rawManufacturer,
    manufacturerId: manufacturer.id,
    manufacturer: manufacturer.displayName,
    rawCategory
  }, classification, evidence);
}

export function normalizeCatalogProducts(products, adapter = {}) {
  return products.map(product => normalizeCatalogProduct(product, adapter));
}

export const CATEGORY_CLASSIFICATION_METADATA_VERSION = CLASSIFICATION_METADATA_VERSION;
