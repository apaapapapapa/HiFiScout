import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deactivateProductsNotSeenInRun,
  listProducts,
  selectExistingProducts,
  selectProductsForHistory
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
            async run() { return { success: true }; }
          };
        }
      };
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

test('deactivation uses observation timestamp instead of a large NOT IN list', async () => {
  const db = queryCaptureDb();
  const observedAt = '2026-08-11T00:55:00.000Z';

  await deactivateProductsNotSeenInRun(db, 'formusic', observedAt);

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].binds, ['formusic', observedAt]);
  assert.match(db.calls[0].sql, /last_seen_at < \?/);
  assert.doesNotMatch(db.calls[0].sql, /NOT IN/i);
});

test('product listing uses keyset pagination and returns a cursor', async () => {
  const rows = [
    { id: 5, last_changed_at: '2026-08-11T03:00:00Z' },
    { id: 4, last_changed_at: '2026-08-11T02:00:00Z' },
    { id: 3, last_changed_at: '2026-08-11T01:00:00Z' }
  ];
  const db = queryCaptureDb(rows);
  const first = await listProducts(db, new URL('https://example.test/api/products?sort=updated&limit=2'));

  assert.deepEqual(first.items.map(row => row.id), [5, 4]);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.match(db.calls[0].sql, /ORDER BY p\.last_changed_at DESC, p\.id DESC/);
  assert.doesNotMatch(db.calls[0].sql, /OFFSET/);
  assert.doesNotMatch(db.calls[0].sql, /price_history/);
  assert.equal(db.calls[0].binds.at(-1), 3);

  const nextDb = queryCaptureDb([]);
  await listProducts(nextDb, new URL(`https://example.test/api/products?sort=updated&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`));
  assert.match(nextDb.calls[0].sql, /p\.last_changed_at < \?/);
  assert.deepEqual(nextDb.calls[0].binds.slice(0, 3), ['2026-08-11T02:00:00Z', '2026-08-11T02:00:00Z', 4]);
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
