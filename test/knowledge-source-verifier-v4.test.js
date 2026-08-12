import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPANDED_OFFICIAL_SOURCES,
  KNOWLEDGE_CATALOG_VERIFIER_VERSION,
  createKnowledgeSourceVerifierV4,
  expandedKnowledgeSourceEnv
} from '../src/catalog/knowledge-source-verifier-v4.js';

const EXPANDED_MANUFACTURERS = [
  'sony',
  'mcintosh',
  'mark-levinson',
  'kef',
  'jbl',
  'dali',
  'audio-technica',
  'ortofon',
  'stax',
  'fostex',
  'focal'
];

test('v4 expands the official source registry without changing the canonical taxonomy', () => {
  assert.equal(KNOWLEDGE_CATALOG_VERIFIER_VERSION, 4);
  assert.deepEqual(
    EXPANDED_OFFICIAL_SOURCES.map(source => source.manufacturerId),
    EXPANDED_MANUFACTURERS
  );

  const verifier = createKnowledgeSourceVerifierV4({}, { fetchImpl: async () => new Response('not found', { status: 404 }) });
  for (const manufacturerId of EXPANDED_MANUFACTURERS) {
    assert.equal(verifier.definitions.has(manufacturerId), true, `${manufacturerId} should have an official source`);
  }

  // v3 already supports eight manufacturers; v4 adds eleven without replacing them.
  assert.equal(verifier.definitions.size, 19);
});

test('deployment source overrides retain disable and replacement semantics after expansion', () => {
  const expanded = expandedKnowledgeSourceEnv({
    KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON: JSON.stringify([
      { manufacturerId: 'stax', enabled: false },
      { manufacturerId: 'focal', baseUrl: 'https://official.example/', catalogUrls: ['https://official.example/catalog'] }
    ])
  });
  const registry = JSON.parse(expanded.KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON);
  assert.equal(registry.at(-2).manufacturerId, 'stax');
  assert.equal(registry.at(-2).enabled, false);
  assert.equal(registry.at(-1).manufacturerId, 'focal');

  const verifier = createKnowledgeSourceVerifierV4(expanded, {
    fetchImpl: async () => new Response('not found', { status: 404 })
  });
  assert.equal(verifier.definitions.has('stax'), false);
  assert.equal(verifier.definitions.get('focal')[0].baseUrl, 'https://official.example/');
});

test('v4 generic fallback can promote a newly supported manufacturer from its official product index', async () => {
  const pages = new Map([
    ['https://stax.co.jp/product/', '<html><body><a href="/product/sr-x9000/">SR-X9000</a></body></html>'],
    ['https://stax.co.jp/product/sr-x9000/', '<html><head><title>SR-X9000 Headphones</title></head><body><h1>SR-X9000 Headphones</h1></body></html>']
  ]);
  const requested = [];
  const fetchImpl = async url => {
    requested.push(String(url));
    const body = pages.get(String(url));
    return new Response(body || 'not found', { status: body ? 200 : 404 });
  };
  const verifier = createKnowledgeSourceVerifierV4({}, { fetchImpl });

  const result = await verifier.verifyCandidate({
    manufacturerId: 'stax',
    normalizedModel: 'SR-X9000',
    observedManufacturer: 'STAX',
    observedModel: 'SR-X9000'
  });

  assert.equal(result.status, 'verified');
  assert.equal(result.primaryCategoryId, 'headphone');
  assert.ok(requested.includes('https://stax.co.jp/product/'));
  assert.ok(requested.includes('https://stax.co.jp/product/sr-x9000/'));
});
