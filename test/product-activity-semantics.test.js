import test from 'node:test';
import assert from 'node:assert/strict';
import { listProducts, upsertProducts } from '../src/db/products.js';

function product(overrides = {}) {
  return {
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
    conditionText: '中古',
    priceYen: 1000000,
    stockStatus: 'in_stock',
    sourceUrl: 'https://example.test/p1',
    ...overrides
  };
}

function existingProduct(overrides = {}) {
  return {
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
    condition_text: '中古',
    price_yen: 1000000,
    stock_status: 'in_stock',
    source_url: 'https://example.test/p1',
    source_published_at: null,
    first_seen_at: '2026-08-10T00:00:00.000Z',
    last_seen_at: '2026-08-11T00:00:00.000Z',
    last_activity_at: '2026-08-10T00:00:00.000Z',
    is_active: 1,
    ...overrides
  };
}

function upsertDb(existing = null) {
  const prepared = [];
  const batched = [];
  return {
    prepared,
    batched,
    prepare(sql) {
      return {
        bind(...binds) {
          const statement = {
            sql,
            binds,
            async all() {
              if (/SELECT id, source_id, manufacturer/.test(sql)) return { results: existing ? [existing] : [] };
              if (/SELECT id, source_id FROM products/.test(sql)) return { results: existing ? [{ id: existing.id, source_id: existing.source_id }] : [] };
              if (/SELECT id, source_id, price_yen/.test(sql)) return { results: existing ? [existing] : [] };
              return { results: [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; }
          };
          prepared.push(statement);
          return statement;
        }
      };
    },
    async batch(statements) {
      batched.push(...statements);
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    }
  };
}

test('historical retailer listings do not become fresh activity when first backfilled', async () => {
  const db = upsertDb();
  const sourcePublishedAt = '2026-08-01T15:00:00.000Z';
  const observedAt = '2026-08-12T06:00:00.000Z';

  const result = await upsertProducts(db, 'hifido', [product({ sourcePublishedAt })], observedAt);

  assert.equal(result.changedCount, 1);
  assert.equal(result.activityCount, 0);
  const insert = db.prepared.find(statement => /INSERT INTO products/.test(statement.sql));
  assert.ok(insert);
  assert.match(insert.sql, /source_published_at/);
  assert.ok(insert.binds.includes(sourcePublishedAt));
  assert.equal(insert.binds.at(-1), sourcePublishedAt);
});

test('recent retailer listings remain fresh activity when first discovered', async () => {
  const db = upsertDb();
  const sourcePublishedAt = '2026-08-11T15:00:00.000Z';
  const observedAt = '2026-08-12T06:00:00.000Z';

  const result = await upsertProducts(db, 'hifido', [product({ sourcePublishedAt })], observedAt);

  assert.equal(result.activityCount, 1);
  const insert = db.prepared.find(statement => /INSERT INTO products/.test(statement.sql));
  assert.equal(insert.binds.at(-1), observedAt);
});

test('unknown stock interpretation changes do not create user-facing activity', async () => {
  const db = upsertDb(existingProduct({ stock_status: 'unknown' }));

  const result = await upsertProducts(db, 'hifido', [product({ stockStatus: 'in_stock' })], '2026-08-12T06:00:00.000Z');

  assert.equal(result.changedCount, 1);
  assert.equal(result.activityCount, 0);
});

test('confirmed sold-out to in-stock transition creates user-facing activity', async () => {
  const db = upsertDb(existingProduct({ stock_status: 'sold_out' }));

  const result = await upsertProducts(db, 'hifido', [product({ stockStatus: 'in_stock' })], '2026-08-12T06:00:00.000Z');

  assert.equal(result.changedCount, 1);
  assert.equal(result.activityCount, 1);
});

test('parser and normalization metadata drift does not create user-facing activity', async () => {
  const db = upsertDb(existingProduct({
    raw_manufacturer: 'TAD CORPORATION',
    raw_category: 'SPEAKER',
    source_url: 'https://example.test/p1?old=1'
  }));

  const result = await upsertProducts(db, 'hifido', [product({
    rawManufacturer: 'TAD',
    rawCategory: 'スピーカー',
    sourceUrl: 'https://example.test/p1?new=1'
  })], '2026-08-12T06:00:00.000Z');

  assert.equal(result.changedCount, 1);
  assert.equal(result.activityCount, 0);
});

test('48-hour new filter prefers retailer publication time over crawler discovery time', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...binds) {
          calls.push({ sql, binds });
          return { async all() { return { results: [] }; } };
        }
      };
    }
  };

  await listProducts(db, new URL('https://example.test/api/products?newOnly=true'));

  assert.match(calls[0].sql, /COALESCE\(p\.source_published_at, p\.first_seen_at\)/);
});
