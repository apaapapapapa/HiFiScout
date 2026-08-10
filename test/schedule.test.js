import test from 'node:test';
import assert from 'node:assert/strict';
import { isShopDue } from '../src/crawler/run.js';

test('shop interval is evaluated independently', () => {
  const now = new Date('2026-08-11T00:30:00.000Z');
  assert.equal(isShopDue({ last_attempt_at: '2026-08-11T00:00:00.000Z' }, 30, now), true);
  assert.equal(isShopDue({ last_attempt_at: '2026-08-11T00:10:00.000Z' }, 30, now), false);
  assert.equal(isShopDue({ last_attempt_at: '2026-08-11T00:00:00.000Z' }, 60, now), false);
});
