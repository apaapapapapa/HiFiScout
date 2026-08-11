import { normalizeCategory } from './categories.js';
import { normalizeManufacturer } from './manufacturers.js';

const TITLE_INFERENCE_POLICIES = new Set(['fallback', 'prefer']);

function clean(value = '') {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function resolveCategoryPolicy(adapter = {}) {
  const requested = adapter.categoryPolicy?.titleInference;
  return {
    titleInference: TITLE_INFERENCE_POLICIES.has(requested) ? requested : 'fallback'
  };
}

function normalizeProductCategory({ rawCategory, title, hintedCategory, categoryMapping, categoryPolicy }) {
  if (categoryPolicy.titleInference === 'prefer') {
    const inferredFromTitle = normalizeCategory({ title });
    if (inferredFromTitle.classificationStatus === 'classified') {
      return inferredFromTitle;
    }
  }

  return normalizeCategory({
    rawCategory,
    title,
    hintedCategory,
    categoryMapping
  });
}

export function normalizeCatalogProduct(product, adapter = {}) {
  const rawManufacturer = clean(product.rawManufacturer ?? product.manufacturer ?? '');
  const manufacturerCandidate = clean(product.manufacturer || rawManufacturer);
  const rawCategory = clean(product.rawCategory ?? '');
  const manufacturer = normalizeManufacturer(manufacturerCandidate);
  const categoryPolicy = resolveCategoryPolicy(adapter);
  const category = normalizeProductCategory({
    rawCategory,
    title: product.title || '',
    hintedCategory: product.category || '',
    categoryMapping: adapter.categoryMapping || {},
    categoryPolicy
  });

  return {
    ...product,
    rawManufacturer,
    manufacturerId: manufacturer.id,
    manufacturer: manufacturer.displayName,
    rawCategory,
    primaryCategoryId: category.primaryCategoryId,
    categoryIds: category.categoryIds,
    category: category.displayName,
    classificationStatus: category.classificationStatus,
    classificationSource: category.classificationSource,
    searchAliases: category.searchAliases
  };
}

export function normalizeCatalogProducts(products, adapter = {}) {
  return products.map(product => normalizeCatalogProduct(product, adapter));
}
