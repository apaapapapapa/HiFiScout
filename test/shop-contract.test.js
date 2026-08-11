import test from 'node:test';
import assert from 'node:assert/strict';

import { SHOP_DEFINITIONS } from '../src/config.js';
import { coverageDecision, discoverPages, initialPageQueue } from '../src/crawler/strategies.js';
import { SHOP_PLUGINS } from '../src/crawler/shops/index.js';
import { isTransportConfigured, relayConfiguration } from '../src/crawler/transport.js';

test('all shop plugins satisfy the crawler contract', () => {
  assert.ok(SHOP_PLUGINS.length >= 5);
  assert.equal(new Set(SHOP_PLUGINS.map(plugin => plugin.key)).size, SHOP_PLUGINS.length);

  for (const plugin of SHOP_PLUGINS) {
    assert.ok(plugin.key);
    assert.ok(plugin.name);
    assert.ok(plugin.baseUrl);
    assert.equal(typeof plugin.pageUrls, 'function');
    assert.equal(typeof plugin.parse, 'function');
    assert.equal(plugin.definition.key, plugin.key);
    assert.equal(plugin.definition.name, plugin.name);
    assert.equal(plugin.definition.baseUrl, plugin.baseUrl);
    assert.equal(SHOP_DEFINITIONS[plugin.key], plugin.definition);
    assert.ok(plugin.definition.intervalEnv);
    assert.ok(plugin.definition.enabledEnv);
    assert.ok(plugin.definition.requestDelayEnv);
    assert.ok(plugin.definition.defaultIntervalMinutes > 0);
  }
});

test('relay transport requires the shared crawler configuration', () => {
  const plugin = SHOP_PLUGINS.find(candidate => candidate.key === 'audiounion');
  assert.ok(plugin);

  assert.deepEqual(
    relayConfiguration({
      CRAWL_RELAY_URL: 'https://shared.example/',
      CRAWL_RELAY_TOKEN: 'shared-token'
    }),
    { relayUrl: 'https://shared.example/', relayToken: 'shared-token' }
  );

  assert.equal(isTransportConfigured({
    CRAWL_RELAY_URL: 'https://shared.example/',
    CRAWL_RELAY_TOKEN: 'shared-token'
  }, plugin), true);
  assert.equal(isTransportConfigured({}, plugin), false);
});

test('pagination and coverage strategies preserve existing adapter semantics', () => {
  const fixed = {
    *pageUrls(maxPages) { for (let page = 1; page <= maxPages; page += 1) yield `/${page}`; }
  };
  assert.deepEqual(initialPageQueue(fixed, 2, {}, {}), ['/1', '/2']);
  assert.deepEqual(discoverPages(fixed, '<html>', '/1'), []);

  const complete = coverageDecision({ dynamicPagination: true }, {
    reachedEnd: false,
    coverageIncomplete: false,
    queueEmpty: true
  });
  assert.deepEqual(complete, { deactivateMissing: true, guardItemCount: true });

  const partial = coverageDecision({ partialCoverage: true, guardItemCount: true }, {
    reachedEnd: true,
    coverageIncomplete: false,
    queueEmpty: true
  });
  assert.deepEqual(partial, { deactivateMissing: false, guardItemCount: true });
});
