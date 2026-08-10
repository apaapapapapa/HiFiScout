import test from 'node:test';
import assert from 'node:assert/strict';
import { isPathAllowed } from '../src/crawler/robots.js';

test('robots longest matching rule wins', () => {
  const robots = `User-agent: *\nDisallow: /shop/\nAllow: /shop/r/`;
  assert.equal(isPathAllowed(robots, 'https://example.com/shop/r/used', 'HiFiScoutBot'), true);
  assert.equal(isPathAllowed(robots, 'https://example.com/shop/private', 'HiFiScoutBot'), false);
});
