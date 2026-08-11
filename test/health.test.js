import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncHealth, evaluateShopSyncHealth } from '../src/health.js';

test('sync health becomes warning and critical as success gets stale', () => {
  const now = new Date('2026-08-11T06:00:00.000Z');
  const base = { intervalMinutes: 30, enabled: true, now, warningFactor: 2, criticalFactor: 6 };

  assert.equal(evaluateShopSyncHealth({ ...base, state: { last_success_at: '2026-08-11T05:45:00.000Z' } }).status, 'healthy');
  assert.equal(evaluateShopSyncHealth({ ...base, state: { last_success_at: '2026-08-11T04:30:00.000Z' } }).status, 'warning');
  assert.equal(evaluateShopSyncHealth({ ...base, state: { last_success_at: '2026-08-11T02:00:00.000Z' } }).status, 'critical');
});

test('three consecutive failures are critical even after a recent success', () => {
  const health = evaluateShopSyncHealth({
    state: { last_success_at: '2026-08-11T05:55:00.000Z', consecutive_failures: 3 },
    intervalMinutes: 30,
    enabled: true,
    now: new Date('2026-08-11T06:00:00.000Z')
  });
  assert.equal(health.status, 'critical');
  assert.equal(health.reason, 'repeated_failures');
});

test('disabled shops do not make overall health unhealthy', () => {
  const health = buildSyncHealth({ AUDIOUNION_ENABLED: 'false' }, [
    { shop_key: 'audiounion', consecutive_failures: 10 }
  ], new Date('2026-08-11T06:00:00.000Z'));
  const audioUnion = health.shops.find(shop => shop.shopKey === 'audiounion');
  assert.equal(audioUnion.status, 'disabled');
  assert.notEqual(health.status, 'critical');
});
