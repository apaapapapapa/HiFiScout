import test from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, categoryClosureIds, categoryIdForFilter, getCategory } from '../src/catalog/categories.js';
import { normalizeCatalogProduct } from '../src/catalog/product-normalizer.js';

const top = () => CATEGORIES.filter(category => category.parentId == null);
const children = parentId => CATEGORIES.filter(category => category.parentId === parentId);

function classify(title) {
  return normalizeCatalogProduct({
    manufacturer: '', rawManufacturer: '', title, category: '', rawCategory: ''
  }, { categoryPolicy: { parserHint: 'ignore', sellerCategory: { default: 'corroborative' } } });
}

test('top-level taxonomy has explicit required order', () => {
  assert.deepEqual(top().map(category => category.id), [
    'amplifier', 'digital', 'analog', 'speaker', 'headphone_group', 'accessories', 'dj_dtm', 'other'
  ]);
  assert.deepEqual(top().map(category => category.order), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('group parents are filterable but never classifiable', () => {
  for (const id of ['amplifier', 'digital', 'analog', 'speaker', 'headphone_group', 'accessories']) {
    assert.equal(getCategory(id).classifiable, false);
    assert.equal(getCategory(id).filterable, true);
  }
  assert.ok(CATEGORIES.filter(category => category.parentId).every(category => category.classifiable));
});

test('children retain required definition order', () => {
  assert.deepEqual(children('amplifier').map(category => category.id), ['integrated_amp', 'pre_amp', 'power_amp', 'headphone_amp']);
  assert.deepEqual(children('digital').map(category => category.id), ['dac', 'network_player', 'cd_sacd_player', 'dap']);
  assert.deepEqual(children('speaker').map(category => category.id), ['speaker_bookshelf', 'speaker_floorstanding', 'subwoofer', 'speaker_other']);
  assert.deepEqual(children('accessories').map(category => category.id), ['cable', 'rack', 'power_accessory', 'vacuum_tube', 'other_accessory']);
});

test('legacy category aliases resolve to canonical ids', () => {
  assert.equal(categoryIdForFilter('network_transport'), 'network_player');
  assert.equal(categoryIdForFilter('accessory'), 'other_accessory');
});

test('search closure contains leaf and parent only', () => {
  assert.deepEqual(categoryClosureIds('pre_amp'), ['pre_amp', 'amplifier']);
  assert.deepEqual(categoryClosureIds('speaker_bookshelf'), ['speaker_bookshelf', 'speaker']);
  assert.deepEqual(categoryClosureIds('dac'), ['dac', 'digital']);
});

test('composite amplifier titles keep one product category and expose features separately', () => {
  const pre = classify('DAC内蔵 プリアンプ XXXXX');
  assert.equal(pre.primaryCategoryId, 'pre_amp');
  assert.deepEqual(pre.categoryIds, ['pre_amp']);
  assert.equal(pre.featureFacts.find(fact => fact.featureId === 'dac')?.state, 'present');

  const integrated = classify('DAC搭載 プリメインアンプ YYYY');
  assert.equal(integrated.primaryCategoryId, 'integrated_amp');
  assert.deepEqual(integrated.categoryIds, ['integrated_amp']);
  assert.equal(integrated.featureFacts.find(fact => fact.featureId === 'dac')?.state, 'present');
});

test('transports are classified as their player family', () => {
  assert.equal(classify('Network Transport N1').primaryCategoryId, 'network_player');
  assert.equal(classify('CD Transport D1').primaryCategoryId, 'cd_sacd_player');
});

test('speaker classification uses strong form-factor evidence only', () => {
  assert.equal(classify('Bookshelf Speaker Model A').primaryCategoryId, 'speaker_bookshelf');
  assert.equal(classify('Floorstanding Speaker Model B').primaryCategoryId, 'speaker_floorstanding');
  assert.equal(classify('Subwoofer Model C').primaryCategoryId, 'subwoofer');
  assert.equal(classify('Speaker Model D').primaryCategoryId, 'speaker_other');
  assert.equal(classify('SUB Model E').primaryCategoryId, 'other');
});

test('accessory precedence prevents target component words from stealing classification', () => {
  assert.equal(classify('ヘッドホンケーブル 2m').primaryCategoryId, 'cable');
  assert.equal(classify('スピーカーケーブル 3m').primaryCategoryId, 'cable');
  assert.equal(classify('電源ケーブル 1.5m').primaryCategoryId, 'cable');
  assert.equal(classify('電源タップ 6口').primaryCategoryId, 'power_accessory');
  assert.equal(classify('インシュレーター 4個').primaryCategoryId, 'other_accessory');
});
