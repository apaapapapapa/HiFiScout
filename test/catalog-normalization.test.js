import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCategory } from '../src/catalog/categories.js';
import { normalizeManufacturer } from '../src/catalog/manufacturers.js';
import { normalizeCatalogProduct } from '../src/catalog/product-normalizer.js';

test('shop category mapping wins over shared inference', () => {
  const result = normalizeCategory({
    rawCategory: 'CONTROL AMP',
    title: 'Example Network DAC',
    categoryMapping: { 'CONTROL AMP': 'pre_amp' }
  });

  assert.equal(result.primaryCategoryId, 'pre_amp');
  assert.deepEqual(result.categoryIds, ['pre_amp']);
  assert.equal(result.displayName, 'プリアンプ');
  assert.equal(result.classificationStatus, 'classified');
});

test('shop mappings can classify a product into multiple canonical categories', () => {
  const result = normalizeCategory({
    rawCategory: 'ネットワークDAC',
    categoryMapping: { 'ネットワークDAC': ['dac', 'network_player'] }
  });

  assert.equal(result.primaryCategoryId, 'dac');
  assert.deepEqual(result.categoryIds, ['dac', 'network_player']);
  assert.match(result.searchAliases, /ネットワークプレーヤー/);
  assert.match(result.searchAliases, /D\/Aコンバーター/i);
});

test('title inference suppresses component words inside accessory and amplifier names', () => {
  assert.deepEqual(normalizeCategory({ title: 'Premium Speaker Cable 2m' }).categoryIds, ['cable']);
  assert.deepEqual(normalizeCategory({ title: 'Reference Headphone Amplifier' }).categoryIds, ['headphone_amp']);
  assert.deepEqual(normalizeCategory({ title: 'Network Transport' }).categoryIds, ['network_transport']);
});

test('DAC inference requires a DAC-specific expression rather than generic converter wording', () => {
  assert.equal(normalizeCategory({ title: 'D/A Converter Model X' }).primaryCategoryId, 'dac');
  assert.equal(normalizeCategory({ title: 'AC Power Converter Model X' }).primaryCategoryId, 'other');
});

test('manufacturer aliases collapse Japanese and English spellings', () => {
  assert.deepEqual(normalizeManufacturer('LUXMAN'), {
    id: 'luxman', displayName: 'LUXMAN', matchedAlias: true
  });
  assert.deepEqual(normalizeManufacturer('ラックスマン'), {
    id: 'luxman', displayName: 'LUXMAN', matchedAlias: true
  });
  assert.equal(normalizeManufacturer('B&W').id, 'bowers-wilkins');
  assert.equal(normalizeManufacturer('iFi Audio Japan').id, 'ifi-audio');
});

test('raw seller values are preserved while UI values are canonicalized', () => {
  const product = normalizeCatalogProduct({
    sourceId: '1',
    rawManufacturer: 'LUXMAN ラックスマン',
    manufacturer: 'LUXMAN',
    model: 'C-10X',
    title: 'LUXMAN C-10X',
    rawCategory: 'コントロールアンプ',
    category: 'コントロールアンプ'
  }, {
    categoryMapping: { 'コントロールアンプ': 'pre_amp' }
  });

  assert.equal(product.rawManufacturer, 'LUXMAN ラックスマン');
  assert.equal(product.manufacturerId, 'luxman');
  assert.equal(product.manufacturer, 'LUXMAN');
  assert.equal(product.rawCategory, 'コントロールアンプ');
  assert.equal(product.primaryCategoryId, 'pre_amp');
  assert.deepEqual(product.categoryIds, ['pre_amp']);
  assert.equal(product.category, 'プリアンプ');
});

test('unknown products remain visible but are explicitly unclassified', () => {
  const result = normalizeCategory({ rawCategory: '特殊機器', title: 'Mystery Device XYZ' });
  assert.equal(result.primaryCategoryId, 'other');
  assert.deepEqual(result.categoryIds, ['other']);
  assert.equal(result.classificationStatus, 'unclassified');
});
