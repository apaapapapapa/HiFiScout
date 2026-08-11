import test from 'node:test';
import assert from 'node:assert/strict';
import { deactivateProductsNotSeenInRun, selectProductsForHistory } from '../src/db/products.js';

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

test('deactivation uses observation timestamp instead of a large NOT IN list', async () => {
  const db = queryCaptureDb();
  const observedAt = '2026-08-11T00:55:00.000Z';

  await deactivateProductsNotSeenInRun(db, 'formusic', observedAt);

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].binds, ['formusic', observedAt]);
  assert.match(db.calls[0].sql, /last_seen_at < \?/);
  assert.doesNotMatch(db.calls[0].sql, /NOT IN/i);
});
