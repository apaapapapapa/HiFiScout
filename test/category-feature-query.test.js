import test from 'node:test';
import assert from 'node:assert/strict';

import { listProducts, validateProductQuery } from '../src/db/products.js';

function queryCaptureDb(results = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...binds) {
          calls.push({ sql, binds });
          return { async all() { return { results }; } };
        }
      };
    }
  };
}

test('parent category uses product category closure', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?category=amplifier'));
  assert.match(db.calls[0].sql, /product_categories pc/);
  assert.equal(db.calls[0].binds[0], 'amplifier');
});

test('leaf DAC category remains a product-type filter', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?category=dac'));
  assert.match(db.calls[0].sql, /product_categories pc/);
  assert.doesNotMatch(db.calls[0].sql, /product_feature_facts/);
  assert.equal(db.calls[0].binds[0], 'dac');
});

test('feature=dac is a separate positive feature filter', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?feature=dac'));
  assert.match(db.calls[0].sql, /product_feature_facts pff/);
  assert.match(db.calls[0].sql, /pff\.state = 'present'/);
  assert.equal(db.calls[0].binds[0], 'dac');
});

test('multiple feature parameters are ANDed and unknown feature ids are rejected', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?feature=dac&feature=network_playback'));
  assert.equal((db.calls[0].sql.match(/product_feature_facts pff/g) || []).length, 2);
  assert.deepEqual(db.calls[0].binds.slice(0, 2), ['dac', 'network_playback']);
  assert.equal(validateProductQuery(new URL('https://example.test/api/products?feature=magic')), 'feature_invalid');
});

test('legacy network transport filter resolves to network player', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?category=network_transport'));
  assert.equal(db.calls[0].binds[0], 'network_player');
});
