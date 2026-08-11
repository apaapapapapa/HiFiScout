import test from 'node:test';
import assert from 'node:assert/strict';
import { dueDispatchCandidates, isDispatchLeaseActive } from '../src/crawler/dispatch.js';

const ONLY_HIFIDO = {
  AUDIOUNION_ENABLED: 'false',
  IPPINKAN_ENABLED: 'false',
  FUJIYA_AVIC_ENABLED: 'false',
  FORMUSIC_ENABLED: 'false',
  HIFIDO_ENABLED: 'true',
  HIFIDO_INTERVAL_MINUTES: '30',
  CRAWL_DISPATCH_LEASE_MINUTES: '15'
};

test('recent queue lease prevents duplicate dispatch', () => {
  const now = new Date('2026-08-11T06:00:00.000Z');
  assert.equal(isDispatchLeaseActive({ queued_at: '2026-08-11T05:50:00.000Z' }, now, 15), true);
  assert.equal(isDispatchLeaseActive({ queued_at: '2026-08-11T05:40:00.000Z' }, now, 15), false);
});

test('due shop is dispatched again after a stale queue lease', () => {
  const now = new Date('2026-08-11T06:00:00.000Z');
  const recentLease = dueDispatchCandidates(ONLY_HIFIDO, [{
    shop_key: 'hifido',
    last_attempt_at: '2026-08-11T05:00:00.000Z',
    queued_at: '2026-08-11T05:50:00.000Z'
  }], now);
  assert.equal(recentLease.length, 0);

  const staleLease = dueDispatchCandidates(ONLY_HIFIDO, [{
    shop_key: 'hifido',
    last_attempt_at: '2026-08-11T05:00:00.000Z',
    queued_at: '2026-08-11T05:40:00.000Z'
  }], now);
  assert.deepEqual(staleLease.map(candidate => candidate.adapter.key), ['hifido']);
});
