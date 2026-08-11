import { normalizeCategory } from './categories.js';
import { normalizeManufacturer } from './manufacturers.js';

function clean(value = '') {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function normalizeCatalogProduct(product, adapter = {}) {
  const rawManufacturer = clean(product.rawManufacturer ?? product.manufacturer ?? '');
  const rawCategory = clean(product.rawCategory ?? '');
  const manufacturer = normalizeManufacturer(rawManufacturer);
  const category = normalizeCategory({
    rawCategory,
    title: product.title || '',
    hintedCategory: product.category || '',
    categoryMapping: adapter.categoryMapping || {}
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
