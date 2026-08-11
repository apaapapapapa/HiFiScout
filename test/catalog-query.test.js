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

test('canonical category display names filter through indexed product categories', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?category=プリアンプ'));

  assert.match(db.calls[0].sql, /EXISTS \(SELECT 1 FROM product_categories pc/);
  assert.deepEqual(db.calls[0].binds.slice(0, 1), ['pre_amp']);
});

test('manufacturer aliases filter through canonical manufacturer id', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?manufacturer=ラックスマン'));

  assert.match(db.calls[0].sql, /p\.manufacturer_id = \?/);
  assert.deepEqual(db.calls[0].binds.slice(0, 2), ['luxman', 'ラックスマン']);
});

test('short free-text searches include raw seller catalog fields and canonical aliases', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?q=MC'));

  assert.match(db.calls[0].sql, /p\.raw_manufacturer LIKE \?/);
  assert.match(db.calls[0].sql, /p\.raw_category LIKE \?/);
  assert.match(db.calls[0].sql, /p\.search_aliases LIKE \?/);
  assert.equal(db.calls[0].binds.filter(value => value === '%MC%').length, 7);
});

test('recent-only filter constrains products to the last 48 hours', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?newOnly=true'));

  assert.match(db.calls[0].sql, /p\.first_seen_at >= strftime\([^\n]+-48 hours/);
});

test('price-dropped filter compares current and previous price', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?priceDropped=true'));

  assert.match(db.calls[0].sql, /p\.previous_price_yen IS NOT NULL/);
  assert.match(db.calls[0].sql, /p\.price_yen < p\.previous_price_yen/);
});

test('discovery filters combine with existing catalog filters in one SQL query', async () => {
  const db = queryCaptureDb();
  await listProducts(db, new URL('https://example.test/api/products?shop=fujiya-avic&manufacturer=LUXMAN&minPrice=100000&inStock=true&newOnly=true&priceDropped=true'));

  const { sql, binds } = db.calls[0];
  assert.match(sql, /p\.shop_key = \?/);
  assert.match(sql, /p\.manufacturer_id = \?/);
  assert.match(sql, /p\.stock_status = 'in_stock'/);
  assert.match(sql, /p\.first_seen_at >= strftime\([^\n]+-48 hours/);
  assert.match(sql, /p\.price_yen < p\.previous_price_yen/);
  assert.match(sql, /p\.price_yen >= \?/);
  assert.deepEqual(binds.slice(0, 4), ['fujiya-avic', 'luxman', 'LUXMAN', 100000]);
});

test('boolean product filters reject unsupported values', () => {
  assert.equal(
    validateProductQuery(new URL('https://example.test/api/products?newOnly=1')),
    'newOnly_invalid'
  );
  assert.equal(
    validateProductQuery(new URL('https://example.test/api/products?priceDropped=yes')),
    'priceDropped_invalid'
  );
});
