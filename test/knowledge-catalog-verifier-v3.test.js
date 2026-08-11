import test from 'node:test';
import assert from 'node:assert/strict';

import { catalogModelLookupVariants } from '../src/catalog/knowledge-catalog.js';
import { inferExplicitCategoryIds } from '../src/catalog/category-rules.js';
import { createKnowledgeSourceVerifierV3 } from '../src/catalog/knowledge-source-verifier-v3.js';

function variants(manufacturerId, model) {
  return catalogModelLookupVariants({ manufacturerId, model });
}

test('catalog lookup aliases remove listing-only Denon presentation suffixes conservatively', () => {
  assert.ok(variants('denon', 'DP-400-BK [DP400BKEM]').includes('DP-400'));
  assert.ok(variants('denon', 'DCD-755RE-SP').includes('DCD-755RE'));
  assert.ok(variants('denon', 'DL-103《JP-u》【販売済】').includes('DL-103'));
  assert.ok(variants('denon', 'RCD-N12/ブラック').includes('RCD-N12'));
  assert.ok(variants('denon', 'PerL Pro/ホワイト').includes('PERL PRO'));
  assert.ok(variants('denon', 'AH-D9200EM').includes('AH-D9200'));
});

test('catalog lookup aliases preserve meaningful revisions and do not reinterpret accessories', () => {
  assert.ok(variants('yamaha', 'YH-5000SE(B)').includes('YH-5000SE'));
  assert.ok(variants('accuphase', 'C-2800+AD-290V').includes('C-2800'));
  assert.deepEqual(variants('yamaha', 'GT-2000ダストカバー'), ['GT-2000ダストカバー']);
  assert.ok(variants('esoteric', 'K-01XD').includes('K-01XD'));
  assert.ok(variants('final', 'D8000 Pro Limited Edition').includes('D8000 PRO LIMITED EDITION'));
});

test('official taxonomy covers soundbars, tuners, dividers, equalizers, clocks and AV receivers', () => {
  assert.deepEqual(inferExplicitCategoryIds('DHT-S217 Soundbar', { context: 'detail' }), ['soundbar']);
  assert.deepEqual(inferExplicitCategoryIds('T-11 FM Stereo Tuner', { context: 'detail' }), ['tuner']);
  assert.deepEqual(inferExplicitCategoryIds('DF-65 Digital Frequency Dividing Network', { context: 'detail' }), ['crossover']);
  assert.deepEqual(inferExplicitCategoryIds('DG-68 Digital Voicing Equalizer', { context: 'detail' }), ['equalizer']);
  assert.deepEqual(inferExplicitCategoryIds('G-02 Master Clock Generator', { context: 'detail' }), ['clock_generator']);
  assert.deepEqual(inferExplicitCategoryIds('RX-V4A AV Receiver', { context: 'detail' }), ['av_receiver']);
  assert.deepEqual(inferExplicitCategoryIds('GT-2000 ダストカバー', { context: 'title' }), ['other_accessory']);
});

test('v3 verifies a simplified Denon model from an official category index and keeps listing identity', async () => {
  const pages = new Map([
    ['https://www.denon.com/ja-jp/category/turntables/', '<html><body><h1>Turntables</h1><div><a href="/item/dp400">DP-400</a></div></body></html>']
  ]);
  const fetchImpl = async url => {
    const body = pages.get(String(url));
    return new Response(body || 'not found', { status: body ? 200 : 404 });
  };
  const verifier = createKnowledgeSourceVerifierV3({}, { fetchImpl, fallbackEnabled: false });
  const result = await verifier.verifyCandidate({
    manufacturerId: 'denon',
    normalizedModel: 'DP-400-BK [DP400BKEM]',
    observedManufacturer: 'DENON',
    observedModel: 'DP-400-BK [DP400BKEM]'
  });

  assert.equal(result.status, 'verified');
  assert.equal(result.primaryCategoryId, 'turntable');
  assert.equal(result.canonicalModel, 'DP-400-BK [DP400BKEM]');
});

test('v3 inherits the nearest official history heading for Accuphase T-11', async () => {
  const history = '<html><body><h2>Tuner</h2><table><tr><td>T-11</td><td>FM Stereo Tuner</td></tr></table></body></html>';
  const fetchImpl = async url => new Response(String(url).includes('/history') ? history : 'not found', {
    status: String(url).includes('/history') ? 200 : 404
  });
  const verifier = createKnowledgeSourceVerifierV3({}, { fetchImpl, fallbackEnabled: false });
  const result = await verifier.verifyCandidate({
    manufacturerId: 'accuphase',
    normalizedModel: 'T-11',
    observedManufacturer: 'Accuphase',
    observedModel: 'T-11'
  });

  assert.equal(result.status, 'verified');
  assert.equal(result.primaryCategoryId, 'tuner');
});
