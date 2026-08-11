import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOP_DEFINITIONS, getShopEnabled, getShopRequestDelayMs } from '../src/config.js';
import { isShopDue, isSuspiciousItemDrop } from '../src/crawler/run.js';

test('shop interval is evaluated independently', () => {
  const now = new Date('2026-08-11T00:30:00.000Z');
  assert.equal(isShopDue({ last_attempt_at: '2026-08-11T00:00:00.000Z' }, 30, now), true);
  assert.equal(isShopDue({ last_attempt_at: '2026-08-11T00:10:00.000Z' }, 30, now), false);
  assert.equal(isShopDue({ last_attempt_at: '2026-08-11T00:00:00.000Z' }, 60, now), false);
});

test('shop kill switch defaults on and can disable a collector', () => {
  const shop = SHOP_DEFINITIONS.hifido;
  assert.equal(getShopEnabled({}, shop), true);
  assert.equal(getShopEnabled({ HIFIDO_ENABLED: 'false' }, shop), false);
  assert.equal(getShopEnabled({ HIFIDO_ENABLED: '0' }, shop), false);
});

test('shop request delay overrides the global fallback', () => {
  assert.equal(getShopRequestDelayMs({}, SHOP_DEFINITIONS.audiounion, 1200), 10_000);
  assert.equal(getShopRequestDelayMs({ AUDIOUNION_REQUEST_DELAY_MS: '15000' }, SHOP_DEFINITIONS.audiounion, 1200), 15_000);
  assert.equal(getShopRequestDelayMs({}, SHOP_DEFINITIONS.ippinkan, 1200), 1200);
});

test('large item-count drops are rejected only after a meaningful baseline', () => {
  assert.equal(isSuspiciousItemDrop(49, 100, { minRatio: 0.5, minBaseline: 20 }), true);
  assert.equal(isSuspiciousItemDrop(50, 100, { minRatio: 0.5, minBaseline: 20 }), false);
  assert.equal(isSuspiciousItemDrop(1, 10, { minRatio: 0.5, minBaseline: 20 }), false);
});
