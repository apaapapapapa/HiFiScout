import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyCategoryEvidence } from '../src/catalog/category-classifier.js';
import { normalizeCategory } from '../src/catalog/categories.js';
import { normalizeManufacturer } from '../src/catalog/manufacturers.js';
import { normalizeCatalogProduct } from '../src/catalog/product-normalizer.js';
import { fujiyaAvicAdapter } from '../src/crawler/shops/fujiya-avic.js';

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
  const product = normalizeCatalogProduct({
    title: 'Mystery Device XYZ',
    rawCategory: '特殊機器'
  });

  assert.equal(product.primaryCategoryId, 'other');
  assert.deepEqual(product.categoryIds, []);
  assert.equal(product.category, '未分類');
  assert.equal(product.classificationStatus, 'unclassified');
  assert.equal(product.classificationState, 'unclassified');
});

test('default shops keep exact seller category precedence for backward compatibility', () => {
  const product = normalizeCatalogProduct({
    title: 'Example SACD Player',
    rawCategory: 'DAP'
  });

  assert.equal(product.primaryCategoryId, 'dap');
  assert.equal(product.classificationSource, 'seller_category');
});

test('corroborative seller categories do not override explicit title evidence', () => {
  const product = normalizeCatalogProduct({
    title: 'Example SACD 10 SACD Player',
    rawCategory: 'DAP'
  }, {
    categoryPolicy: {
      sellerCategory: { categories: { dap: 'corroborative' } }
    }
  });

  assert.equal(product.primaryCategoryId, 'cd_sacd_player');
  assert.equal(product.category, 'CD/SACDプレーヤー');
  assert.equal(product.classificationSource, 'title');
});

test('a corroborative seller category alone remains unclassified instead of becoming a false positive', () => {
  const product = normalizeCatalogProduct({
    title: 'Portable Audio Model X',
    rawCategory: 'DAP'
  }, {
    categoryPolicy: {
      sellerCategory: { categories: { dap: 'corroborative' } }
    }
  });

  assert.equal(product.primaryCategoryId, 'other');
  assert.deepEqual(product.categoryIds, []);
  assert.equal(product.category, '未分類');
  assert.equal(product.classificationStatus, 'unclassified');
  assert.deepEqual(product.candidateCategoryIds, ['dap']);
});

test('broad seller text inferred from multiple product types is never authoritative by itself', () => {
  const product = normalizeCatalogProduct({
    title: 'Model X',
    rawCategory: 'アンプ・スピーカー・プレーヤー'
  });

  assert.equal(product.classificationStatus, 'unclassified');
  assert.deepEqual(product.categoryIds, []);
});

test('conflicting strong evidence is ambiguous and does not populate confirmed categories', () => {
  const result = classifyCategoryEvidence([
    { categoryId: 'dac', source: 'title', strength: 'strong', value: 'DAC' },
    { categoryId: 'cd_sacd_player', source: 'detail', strength: 'strong', value: 'SACD player' }
  ]);

  assert.equal(result.classificationStatus, 'unclassified');
  assert.equal(result.classificationState, 'ambiguous');
  assert.deepEqual(result.categoryIds, []);
  assert.deepEqual(new Set(result.candidateCategoryIds), new Set(['dac', 'cd_sacd_player']));
});

test('compatible strong evidence can confirm a legitimate multi-category product', () => {
  const result = classifyCategoryEvidence([
    { categoryIds: ['dac', 'network_player'], source: 'detail', strength: 'strong', value: 'Network DAC' },
    { categoryId: 'network_player', source: 'structured_data', strength: 'strong', value: 'Network player' }
  ]);

  assert.equal(result.classificationStatus, 'classified');
  assert.deepEqual(result.categoryIds, ['dac', 'network_player']);
});

test('Fujiya uses the generic evidence policy for broad DAP merchandising buckets', () => {
  const sacd = normalizeCatalogProduct({
    title: 'MARANTZ SACD 10 SACD Player',
    rawCategory: 'DAP'
  }, fujiyaAvicAdapter);
  const cable = normalizeCatalogProduct({
    title: 'Premium Headphone Cable 2m',
    rawCategory: 'DAP'
  }, fujiyaAvicAdapter);
  const unresolved = normalizeCatalogProduct({
    title: 'Portable Audio Model X',
    rawCategory: 'DAP'
  }, fujiyaAvicAdapter);

  assert.equal(sacd.primaryCategoryId, 'cd_sacd_player');
  assert.equal(cable.primaryCategoryId, 'cable');
  assert.equal(unresolved.classificationStatus, 'unclassified');
  assert.deepEqual(unresolved.categoryIds, []);
});
