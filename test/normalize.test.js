import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYen, inferStockStatus, splitManufacturerModel } from '../src/crawler/normalize.js';

test('parseYen parses Japanese prices', () => {
  assert.equal(parseYen('￥1,250,000（税込）'), 1250000);
  assert.equal(parseYen('49,900円'), 49900);
});

test('stock status is conservative', () => {
  assert.equal(inferStockStatus('在庫あり'), 'in_stock');
  assert.equal(inferStockStatus('売り切れ'), 'sold_out');
  assert.equal(inferStockStatus('商品情報'), 'unknown');
});

test('Ippinkan title splitting', () => {
  assert.deepEqual(splitManufacturerModel('LUXMAN - D-10X《JP-u》', 'ippinkan'), { manufacturer: 'LUXMAN', model: 'D-10X' });
});
