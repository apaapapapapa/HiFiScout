import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyCategoryEvidence } from '../src/catalog/category-classifier.js';
import {
  buildKnowledgeCatalogCandidateAggregates,
  candidatePriority,
  knowledgeCatalogEvidence,
  knowledgeCatalogKey,
  normalizeCatalogModel
} from '../src/catalog/knowledge-catalog.js';

test('model normalization removes formatting but preserves meaningful suffixes', () => {
  assert.equal(normalizeCatalogModel('K-01 XD'), 'K01XD');
  assert.equal(normalizeCatalogModel('K 01-XD'), 'K01XD');
  assert.notEqual(normalizeCatalogModel('K-01X'), normalizeCatalogModel('K-01XD'));
  assert.notEqual(normalizeCatalogModel('D8000 Pro'), normalizeCatalogModel('D8000 Pro LE'));
});

test('catalog keys require both normalized manufacturer and model identity', () => {
  assert.equal(knowledgeCatalogKey('esoteric', 'K-01 XD'), 'esoteric:K01XD');
  assert.equal(knowledgeCatalogKey('', 'K-01XD'), '');
  assert.equal(knowledgeCatalogKey('esoteric', ''), '');
});

test('candidate aggregation groups formatting variants without promoting inferred data', () => {
  const rows = [
    {
      shop_key: 'audiounion', manufacturer_id: 'esoteric', manufacturer: 'ESOTERIC', model: 'K-01XD',
      title: 'ESOTERIC K-01XD', category_ids: '["cd_sacd_player"]', classification_status: 'classified',
      first_seen_at: '2026-08-01T00:00:00.000Z', last_seen_at: '2026-08-10T00:00:00.000Z'
    },
    {
      shop_key: 'hifido', manufacturer_id: 'esoteric', manufacturer: 'ESOTERIC', model: 'K 01 XD',
      title: 'ESOTERIC K 01 XD', category_ids: '[]', classification_status: 'unclassified',
      first_seen_at: '2026-08-02T00:00:00.000Z', last_seen_at: '2026-08-11T00:00:00.000Z'
    },
    {
      shop_key: 'hifido', manufacturer_id: 'esoteric', manufacturer: 'ESOTERIC', model: 'K-01X',
      title: 'ESOTERIC K-01X', category_ids: '["cd_sacd_player"]', classification_status: 'classified',
      first_seen_at: '2026-08-03T00:00:00.000Z', last_seen_at: '2026-08-09T00:00:00.000Z'
    }
  ];

  const candidates = buildKnowledgeCatalogCandidateAggregates(rows);
  assert.equal(candidates.length, 2);
  const xd = candidates.find(candidate => candidate.normalizedModel === 'K01XD');
  assert.equal(xd.listingCount, 2);
  assert.equal(xd.shopCount, 2);
  assert.equal(xd.unclassifiedCount, 1);
  assert.deepEqual(xd.categoryIds, ['cd_sacd_player']);
  assert.equal(xd.firstSeenAt, '2026-08-01T00:00:00.000Z');
  assert.equal(xd.lastSeenAt, '2026-08-11T00:00:00.000Z');
  assert.equal(xd.priorityScore, candidatePriority(xd));
});

test('verified catalog evidence overrides a conflicting seller category', () => {
  const catalogEvidence = knowledgeCatalogEvidence({
    canonicalName: 'SACD 10',
    canonicalModel: 'SACD 10',
    categoryIds: ['cd_sacd_player']
  });
  const result = classifyCategoryEvidence([
    { categoryId: 'dap', source: 'seller_category', strength: 'authoritative', value: 'DAP' },
    ...catalogEvidence
  ]);

  assert.equal(result.classificationStatus, 'classified');
  assert.equal(result.primaryCategoryId, 'cd_sacd_player');
  assert.deepEqual(result.categoryIds, ['cd_sacd_player']);
  assert.equal(result.classificationSource, 'knowledge_catalog');
});

test('verified catalog evidence can represent multi-category products', () => {
  const result = classifyCategoryEvidence(knowledgeCatalogEvidence({
    canonicalName: 'Network DAC',
    canonicalModel: 'ND-1',
    categoryIds: ['dac', 'network_player']
  }));

  assert.equal(result.classificationStatus, 'classified');
  assert.deepEqual(result.categoryIds, ['dac', 'network_player']);
});
