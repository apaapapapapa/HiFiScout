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

test('relay status-aware fetch returns upstream 404 without throwing', async () => {
  const fetcher = createRelayHtmlFetcher({
    relayUrl: 'https://relay.example/',
    relayToken: 'secret-token',
    fetchFn: async () => new Response('<html>missing</html>', {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-hifiscout-upstream-status': '404'
      }
    })
  });

  const page = await fetcher.fetchPage('https://www.audiounion.jp/ct/detail/used/123/');
  assert.equal(page.status, 404);
  assert.equal(page.contentType, 'text/html; charset=utf-8');
  assert.equal(page.body, '<html>missing</html>');
});

test('relay status-aware fetch distinguishes robots rejection from upstream status', async () => {
  const fetcher = createRelayHtmlFetcher({
    relayUrl: 'https://relay.example/',
    relayToken: 'secret-token',
    fetchFn: async () => new Response('{"error":"robots_disallowed"}', {
      status: 409,
      headers: { 'content-type': 'application/json' }
    })
  });

  await assert.rejects(
    fetcher.fetchPage('https://www.audiounion.jp/ct/detail/used/123/'),
    error => error?.relayStatus === 409 && error?.code === 'robots_disallowed'
  );
});

test('relay transport refuses missing credentials', async () => {
  const fetcher = createRelayHtmlFetcher({ relayUrl: '', relayToken: '' });
  await assert.rejects(
    fetcher.fetchHtmlPage('https://www.audiounion.jp/st/new_arrival_used.html'),
    /relay URL is not configured/
  );
});
