import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deactivateProductsBySourceIds,
  listProducts,
  selectExistingProducts,
  selectProductsForHistory,
  upsertProducts,
  validateProductQuery
} from '../src/db/products.js';

function queryCaptureDb(results = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...binds) {
          calls.push({ sql, binds });
          return {
            async all() { return { results }; },
            async run() { return { success: true, meta: { changes: 1 } }; }
          };
        }
      };
    },
    async batch(statements) {
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    }
  };
}

function upsertCaptureDb(existing) {
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
              if (/SELECT id, source_id FROM products/.test(sql)) {
                return { results: [{ id: existing.id, source_id: existing.source_id }] };
              }
              if (/SELECT id, source_id, price_yen/.test(sql)) return { results: [existing] };
              return { results: [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; }
          };
        }
      };
    },
    async batch(batch) {
      statements.push(...batch);
      return batch.map(() => ({ success: true, meta: { changes: 1 } }));
    }
  };
}

test('history lookup chunks large source-id sets below D1 variable limits', async () => {
  const db = queryCaptureDb();
  const ids = Array.from({ length: 1001 }, (_, index) => `source-${index}`);

  await selectProductsForHistory(db, 'fujiya-avic', ids, 50);

  assert.equal(db.calls.length, 21);
  assert.ok(db.calls.every(call => call.binds.length <= 51));
  assert.ok(db.calls.every(call => /source_id IN/.test(call.sql)));
});

test('existing product lookup only reads source ids observed in the current crawl', async () => {
  const db = queryCaptureDb();
  await selectExistingProducts(db, 'hifido', ['a', 'b']);

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].binds, ['hifido', 'a', 'b']);
  assert.match(db.calls[0].sql, /source_id IN \(\?,\?\)/);
  assert.doesNotMatch(db.calls[0].sql, /WHERE shop_key = \?\s*$/m);
});

test('missing products are deactivated in bounded source-id chunks', async () => {
  const db = queryCaptureDb();
  const ids = Array.from({ length: 121 }, (_, index) => `source-${index}`);

  const changed = await deactivateProductsBySourceIds(db, 'formusic', ids, 50);

  assert.equal(changed, 3);
  assert.equal(db.calls.length, 3);
  assert.ok(db.calls.every(call => call.binds.length <= 51));
  assert.ok(db.calls.every(call => /source_id IN/.test(call.sql)));
  assert.ok(db.calls.every(call => /is_active = 1/.test(call.sql)));
});

test('unchanged products are not rewritten on every crawl', async () => {
  const product = {
    sourceId: 'p1', manufacturer: 'TAD', model: 'ME1TX', title: 'ME1TX', category: 'スピーカー',
    conditionText: '中古', priceYen: 1000000, stockStatus: 'in_stock', sourceUrl: 'https://example.test/p1'
  };
  const existing = {
    id: 1, source_id: 'p1', manufacturer: 'TAD', model: 'ME1TX', title: 'ME1TX', category: 'スピーカー',
    condition_text: '中古', price_yen: 1000000, stock_status: 'in_stock', source_url: 'https://example.test/p1',
    last_seen_at: '2026-08-11T00:00:00.000Z', is_active: 1
  };
  const batches = [];
  const db = {
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            async all() { return { results: /SELECT id, source_id, manufacturer/.test(sql) ? [existing] : [] }; },
            async run() { return { meta: { changes: 1 } }; },
            sql,
            binds
          };
        }
      };
    },
    async batch(statements) { batches.push(statements); return statements.map(() => ({ meta: { changes: 1 } })); }
  };

  const result = await upsertProducts(db, 'hifido', [product], '2026-08-11T00:30:00.000Z', { touchIntervalMinutes: 1440 });

  assert.equal(result.changedCount, 0);
  assert.equal(result.activityCount, 0);
  assert.equal(result.touchedCount, 0);
  assert.equal(batches.length, 0);
});

test('unchanged products receive a low-frequency last-seen heartbeat', async () => {
  const product = {
    sourceId: 'p1', manufacturer: 'TAD', model: 'ME1TX', title: 'ME1TX', category: 'スピーカー',
    conditionText: '中古', priceYen: 1000000, stockStatus: 'in_stock', sourceUrl: 'https://example.test/p1'
  };
  const existing = {
    id: 1, source_id: 'p1', manufacturer: 'TAD', model: 'ME1TX', title: 'ME1TX', category: 'スピーカー',
    condition_text: '中古', price_yen: 1000000, stock_status: 'in_stock', source_url: 'https://example.test/p1',
    last_seen_at: '2026-08-09T00:00:00.000Z', is_active: 1
  };
  const batchedSql = [];
  const db = {
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            async all() { return { results: /SELECT id, source_id, manufacturer/.test(sql) ? [existing] : [] }; },
            async run() { return { meta: { changes: 1 } }; },
            sql,
            binds
          };
        }
      };
    },
    async batch(statements) {
      batchedSql.push(...statements.map(statement => statement.sql));
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };

  const result = await upsertProducts(db, 'hifido', [product], '2026-08-11T00:30:00.000Z', { touchIntervalMinutes: 1440 });

  assert.equal(result.changedCount, 0);
  assert.equal(result.activityCount, 0);
  assert.equal(result.touchedCount, 1);
  assert.equal(batchedSql.length, 1);
  assert.match(batchedSql[0], /last_seen_at/);
});

test('catalog normalization changes do not create user-facing activity', async () => {
  const existing = {
    id: 1,
    source_id: 'p1',
    manufacturer: 'TAD',
    raw_manufacturer: 'TAD',
    manufacturer_id: 'tad',
    model: 'D100',
    title: 'D100',
    category: 'その他',
    raw_category: 'プレーヤー',
    primary_category_id: 'other',
    category_ids: '["other"]',
    classification_status: 'unclassified',
    search_aliases: 'その他 other',
    condition_text: '中古',
    price_yen: 500000,
    stock_status: 'in_stock',
    source_url: 'https://example.test/p1',
    last_seen_at: '2026-08-11T00:00:00.000Z',
    is_active: 1
  };
  const product = {
    sourceId: 'p1',
    manufacturer: 'TAD',
    rawManufacturer: 'TAD',
    manufacturerId: 'tad',
    model: 'D100',
    title: 'D100',
    category: 'CD/SACDプレーヤー',
    rawCategory: 'プレーヤー',
    primaryCategoryId: 'cd_sacd_player',
    categoryIds: ['cd_sacd_player'],
    classificationStatus: 'classified',
    searchAliases: 'CD/SACDプレーヤー cd player sacd player',
    conditionText: '中古',
    priceYen: 500000,
    stockStatus: 'in_stock',
    sourceUrl: 'https://example.test/p1'
  };
  const db = upsertCaptureDb(existing);

  const result = await upsertProducts(db, 'hifido', [product], '2026-08-11T01:00:00.000Z');

  assert.equal(result.changedCount, 1);
  assert.equal(result.activityCount, 0);
  assert.ok(db.statements.some(statement => /UPDATE products SET/.test(statement.sql)));
  assert.ok(db.statements.some(statement => /product_categories/.test(statement.sql)));
});

test('seller-visible listing changes create user-facing activity', async () => {
  const existing = {
    id: 1,
    source_id: 'p1',
    manufacturer: 'TAD',
    raw_manufacturer: 'TAD',
    manufacturer_id: 'tad',
    model: 'ME1TX',
    title: 'ME1TX',
    category: 'スピーカー',
    raw_category: 'スピーカー',
    primary_category_id: 'speaker',
    category_ids: '["speaker"]',
    classification_status: 'classified',
    search_aliases: 'スピーカー speaker',
    condition_text: '中古 A',
    price_yen: 1000000,
    stock_status: 'in_stock',
    source_url: 'https://example.test/p1',
    last_seen_at: '2026-08-11T00:00:00.000Z',
    is_active: 1
  };
  const product = {
    sourceId: 'p1',
    manufacturer: 'TAD',
    rawManufacturer: 'TAD',
    manufacturerId: 'tad',
    model: 'ME1TX',
    title: 'ME1TX',
    category: 'スピーカー',
    rawCategory: 'スピーカー',
    primaryCategoryId: 'speaker',
    categoryIds: ['speaker'],
    classificationStatus: 'classified',
    searchAliases: 'スピーカー speaker',
    conditionText: '中古 B',
    priceYen: 1000000,
    stockStatus: 'in_stock',
    sourceUrl: 'https://example.test/p1'
  };
  const db = upsertCaptureDb(existing);

  const result = await upsertProducts(db, 'hifido', [product], '2026-08-11T01:00:00.000Z');

  assert.equal(result.changedCount, 1);
  assert.equal(result.activityCount, 1);
  const update = db.statements.find(statement => /UPDATE products SET/.test(statement.sql));
  assert.ok(update);
  assert.match(update.sql, /last_activity_at = CASE WHEN \? THEN \? ELSE last_activity_at END/);
});

test('product query validation rejects oversized and malformed inputs', () => {
  assert.equal(validateProductQuery(new URL(`https://example.test/api/products?q=${'x'.repeat(101)}`)), 'q_too_long');
  assert.equal(validateProductQuery(new URL('https://example.test/api/products?limit=-1')), 'limit_invalid');
  assert.equal(validateProductQuery(new URL('https://example.test/api/products?sort=random')), 'sort_invalid');
  assert.equal(validateProductQuery(new URL('https://example.test/api/products?q=TAD&limit=50&sort=newest')), null);
  assert.equal(validateProductQuery(new URL('https://example.test/api/products?sort=updated')), null);
});

test('newest listing uses activity timestamp with keyset pagination', async () => {
  const rows = [
    { id: 5, last_activity_at: '2026-08-11T03:00:00Z' },
    { id: 4, last_activity_at: '2026-08-11T02:00:00Z' },
    { id: 3, last_activity_at: '2026-08-11T01:00:00Z' }
  ];
  const db = queryCaptureDb(rows);
  const first = await listProducts(db, new URL('https://example.test/api/products?sort=newest&limit=2'));

  assert.deepEqual(first.items.map(row => row.id), [5, 4]);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.match(db.calls[0].sql, /ORDER BY p\.last_activity_at DESC, p\.id DESC/);
  assert.doesNotMatch(db.calls[0].sql, /OFFSET/);
  assert.doesNotMatch(db.calls[0].sql, /price_history/);
  assert.equal(db.calls[0].binds.at(-1), 3);

  const nextDb = queryCaptureDb([]);
  await listProducts(nextDb, new URL(`https://example.test/api/products?sort=newest&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`));
  assert.match(nextDb.calls[0].sql, /p\.last_activity_at < \?/);
  assert.deepEqual(nextDb.calls[0].binds.slice(0, 3), ['2026-08-11T02:00:00Z', '2026-08-11T02:00:00Z', 4]);
});

test('updated sort remains a backward-compatible activity alias', async () => {
  const db = queryCaptureDb([]);
  await listProducts(db, new URL('https://example.test/api/products?sort=updated'));
  assert.match(db.calls[0].sql, /ORDER BY p\.last_activity_at DESC, p\.id DESC/);
});

test('three-character searches use the FTS5 index instead of wildcard scans', async () => {
  const db = queryCaptureDb([]);
  await listProducts(db, new URL('https://example.test/api/products?q=D-100'));

  assert.match(db.calls[0].sql, /JOIN products_fts/);
  assert.match(db.calls[0].sql, /products_fts MATCH \?/);
  assert.equal(db.calls[0].binds[0], '"D-100"');
  assert.doesNotMatch(db.calls[0].sql, /title LIKE/);
});

test('price sorting uses NULLS LAST so the price index can satisfy ordering', async () => {
  const db = queryCaptureDb([]);
  await listProducts(db, new URL('https://example.test/api/products?sort=priceAsc'));
  assert.match(db.calls[0].sql, /ORDER BY p\.price_yen ASC NULLS LAST, p\.id ASC/);
  assert.doesNotMatch(db.calls[0].sql, /price_yen IS NULL ASC/);
});
