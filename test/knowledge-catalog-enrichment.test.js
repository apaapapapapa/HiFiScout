import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCatalogProduct } from '../src/catalog/product-normalizer.js';
import { enrichProductCategories } from '../src/crawler/category-enricher.js';
import { fujiyaAvicAdapter } from '../src/crawler/shops/fujiya-avic.js';

function catalogDb(rows, aliases = []) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes('FROM knowledge_catalog_products')) return { results: rows };
              if (sql.includes('FROM knowledge_catalog_aliases')) return { results: aliases };
              throw new Error(`unexpected query: ${sql}`);
            }
          };
        }
      };
    }
  };
}

test('verified exact catalog match classifies before seller detail enrichment', async () => {
  const product = normalizeCatalogProduct({
    sourceId: 'abc1',
    manufacturer: 'Marantz',
    model: 'ABC-1',
    title: 'Marantz ABC-1',
    rawCategory: 'DAP',
    sourceUrl: 'https://example.invalid/abc1'
  }, fujiyaAvicAdapter);
  assert.equal(product.classificationStatus, 'unclassified');

  const db = catalogDb([{
    id: 10,
    manufacturer_id: 'marantz',
    canonical_model: 'ABC-1',
    normalized_model: 'ABC-1',
    canonical_name: 'ABC-1 Control Amplifier',
    category_id: 'pre_amp',
    is_primary: 1
  }]);
  const result = await enrichProductCategories({
    db,
    adapter: fujiyaAvicAdapter,
    products: [product],
    transport: { async fetchHtmlPage() { throw new Error('detail request must not run'); } },
    fetchOptions: {},
    now: new Date('2026-08-11T10:00:00Z')
  });

  assert.equal(result.catalogMatches, 1);
  assert.equal(result.detailRequests, 0);
  assert.equal(result.products[0].primaryCategoryId, 'pre_amp');
  assert.equal(result.products[0].classificationSource, 'knowledge_catalog');
  assert.equal(result.products[0].metadata.categoryClassification.catalogProductId, 10);
  assert.equal(result.products[0].metadata.categoryClassification.catalogMatchType, 'exact');
});

test('ambiguous model aliases are not used as verified evidence', async () => {
  const product = normalizeCatalogProduct({
    sourceId: 'alias1',
    manufacturer: 'Marantz',
    model: 'SHARED',
    title: 'Marantz SHARED',
    rawCategory: 'DAP'
  }, fujiyaAvicAdapter);

  const db = catalogDb([
    {
      id: 10, manufacturer_id: 'marantz', canonical_model: 'ABC-1', normalized_model: 'ABC-1',
      canonical_name: 'ABC-1', category_id: 'pre_amp', is_primary: 1
    },
    {
      id: 11, manufacturer_id: 'marantz', canonical_model: 'ABC-2', normalized_model: 'ABC-2',
      canonical_name: 'ABC-2', category_id: 'dac', is_primary: 1
    }
  ], [
    { product_id: 10, normalized_alias: 'SHARED' },
    { product_id: 11, normalized_alias: 'SHARED' }
  ]);

  const result = await enrichProductCategories({
    db,
    adapter: { ...fujiyaAvicAdapter, extractDetailCategoryEvidence: undefined },
    products: [product],
    transport: {},
    fetchOptions: {},
    now: new Date('2026-08-11T10:00:00Z')
  });

  assert.equal(result.catalogMatches, 0);
  assert.equal(result.products[0].classificationStatus, 'unclassified');
});
