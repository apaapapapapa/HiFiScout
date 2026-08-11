import test from 'node:test';
import assert from 'node:assert/strict';

import { upsertProducts } from '../src/db/products.js';

function captureDb(existing) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            sql,
            binds,
            async all() {
              if (/SELECT id, source_id, manufacturer/.test(sql)) return { results: [existing] };
              if (/SELECT id, source_id FROM products/.test(sql)) return { results: [{ id: existing.id, source_id: existing.source_id }] };
              if (/SELECT id, source_id, price_yen/.test(sql)) return { results: [existing] };
              return { results: [] };
            }
          };
        }
      };
    },
    async batch(batch) {
      statements.push(...batch);
      return batch.map(() => ({ meta: { changes: 1 } }));
    }
  };
}

test('unclassified products persist the canonical other leaf instead of stale seller categories', async () => {
  const existing = {
    id: 1, source_id: 'p1', manufacturer: 'Example', raw_manufacturer: 'Example', manufacturer_id: 'example',
    model: 'ABC-123', title: 'Example ABC-123', category: 'DAP', raw_category: 'DAP', primary_category_id: 'dap',
    category_ids: '["dap"]', classification_status: 'classified', search_aliases: 'DAP digital audio player',
    condition_text: '中古', price_yen: 100000, stock_status: 'in_stock', source_url: 'https://example.test/p1',
    last_seen_at: '2026-08-11T00:00:00.000Z', is_active: 1
  };
  const product = {
    sourceId: 'p1', manufacturer: 'Example', rawManufacturer: 'Example', manufacturerId: 'example', model: 'ABC-123',
    title: 'Example ABC-123', category: '未分類', rawCategory: 'DAP', primaryCategoryId: 'other', categoryIds: [],
    classificationStatus: 'unclassified', searchAliases: '', conditionText: '中古', priceYen: 100000,
    stockStatus: 'in_stock', sourceUrl: 'https://example.test/p1'
  };
  const db = captureDb(existing);

  await upsertProducts(db, 'fujiya-avic', [product], '2026-08-11T01:00:00.000Z');

  const categoryStatements = db.statements.filter(statement => /product_categories/.test(statement.sql));
  assert.ok(categoryStatements.some(statement => /DELETE FROM product_categories/.test(statement.sql)));
  const insert = categoryStatements.find(statement => /INSERT OR IGNORE INTO product_categories/.test(statement.sql));
  assert.ok(insert);
  assert.ok(insert.binds.includes('other'));

  const update = db.statements.find(statement => /UPDATE products SET/.test(statement.sql));
  assert.ok(update);
  assert.ok(update.binds.includes('["other"]'));
  assert.ok(update.binds.includes('unclassified'));
});
