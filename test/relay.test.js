import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayHtmlFetcher } from '../src/crawler/relay.js';

test('relay transport forwards target, delay and crawler identity', async () => {
  let request;
  const fetcher = createRelayHtmlFetcher({
    relayUrl: 'https://relay.example/',
    relayToken: 'secret-token',
    fetchFn: async (url, options) => {
      request = { url, options };
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    }
  });

  const html = await fetcher.fetchHtmlPage('https://www.audiounion.jp/st/new_arrival_used.html', {
    userAgent: 'HiFiScoutBot/0.1',
    requestDelayMs: 10_000
  });

  assert.equal(html, '<html>ok</html>');
  assert.equal(request.url, 'https://relay.example/');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(request.options.body), {
    url: 'https://www.audiounion.jp/st/new_arrival_used.html',
    userAgent: 'HiFiScoutBot/0.1',
    requestDelayMs: 10_000
  });
});

test('relay transport preserves upstream crawl status', async () => {
  const fetcher = createRelayHtmlFetcher({
    relayUrl: 'https://relay.example/',
    relayToken: 'secret-token',
    fetchFn: async () => new Response('not found', {
      status: 404,
      headers: {
        'content-type': 'text/plain',
        'x-hifiscout-upstream-status': '404'
      }
    })
  });

  await assert.rejects(
    fetcher.fetchHtmlPage('https://www.audiounion.jp/st/new_arrival_used.html'),
    /crawl failed with HTTP 404/
  );
});

test('relay transport refuses missing credentials', async () => {
  const fetcher = createRelayHtmlFetcher({ relayUrl: '', relayToken: '' });
  await assert.rejects(
    fetcher.fetchHtmlPage('https://www.audiounion.jp/st/new_arrival_used.html'),
    /relay URL is not configured/
  );
});
