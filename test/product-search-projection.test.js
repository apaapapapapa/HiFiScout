import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductSearchProjection } from '../src/db/product-search-projection-repository.js';

test('search projection contains deterministic manufacturer and model aliases', () => {
  const projection = buildProductSearchProjection({
    id: 1,
    manufacturer_id: 'tad',
    manufacturer: 'TAD',
    raw_manufacturer: 'Technical Audio Devices',
    model: 'D-1000 MKII',
    title: 'Technical Audio Devices D-1000 MKII',
    category: 'DAC',
    raw_category: 'D/Aコンバーター',
    search_aliases: 'DAC D/A Converter DAコンバーター',
  });

  assert.equal(projection.normalizedModel, 'D1000MK2');
  assert.match(projection.manufacturerTerms, /TAD/);
  assert.match(projection.manufacturerTerms, /technical audio devices/i);
  assert.match(projection.modelTerms, /D1000MK2/);
  assert.match(projection.modelTerms, /D1000 MKII/);
  assert.match(projection.categoryTerms, /D\/A Converter/);
});
