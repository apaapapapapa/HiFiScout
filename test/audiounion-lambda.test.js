import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../infra/audiounion-lambda/index.mjs';

const ENTRY_URL = 'https://www.audiounion.jp/st/new_arrival_used.html';
const DETAIL_URL = 'https://www.audiounion.jp/ct/detail/used/223257/';
const HIFIDO_URL = 'https://www.hifido.co.jp/?L=50&LNG=J&O=0&OD=0';
const TOKEN = '0123456789abcdef0123456789abcdef';

function event(body = {}, token = TOKEN) {
  return {
    headers: { authorization: `Bearer ${token}` },
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
    isBase64Encoded: false
  };
}

function env(overrides = {}) {
  return {
    RELAY_TOKEN: TOKEN,
    AUDIOUNION_ENTRY_URL: ENTRY_URL,
    CRAWLER_USER_AGENT: 'HiFiScoutBot/0.1',
    MIN_REQUEST_DELAY_MS: '10000',
    AWS_REGION: 'ap-northeast-1',
    ...overrides
  };
}

test('Lambda rejects unauthorized requests before seller access', async () => {
  let fetchCount = 0;
  const handler = createHandler({ env: env(), fetchFn: async () => { fetchCount += 1; throw new Error('must not fetch'); }, sleepFn: async () => {} });
  const result = await handler(event({ url: ENTRY_URL }, 'wrong-token'));
  assert.equal(result.statusCode, 401);
  assert.equal(fetchCount, 0);
});

test('Lambda only permits allowlisted seller targets', async () => {
  let fetchCount = 0;
  const handler = createHandler({ env: env(), fetchFn: async () => { fetchCount += 1; throw new Error('must not fetch'); }, sleepFn: async () => {} });
  const result = await handler(event({ url: 'https://example.com/' }));
  assert.equal(result.statusCode, 400);
  assert.equal(JSON.parse(result.body).error, 'target_not_allowed');
  assert.equal(fetchCount, 0);
});

test('Lambda permits AudioUnion used detail URLs and still evaluates robots', async () => {
  const calls = [];
  const html = '<html><body>販売価格 ¥798,000</body></html>';
  const handler = createHandler({
    env: env({ MIN_REQUEST_DELAY_MS: '0' }),
    sleepFn: async () => {},
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /ct/search\nAllow: /ct/detail/used/\n', { status: 200 });
      }
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  });

  const result = await handler(event({ url: DETAIL_URL }));

  assert.equal(result.statusCode, 200);
  assert.equal(Buffer.from(result.body, 'base64').toString('utf8'), html);
  assert.equal(calls[0].url, 'https://www.audiounion.jp/robots.txt');
  assert.equal(calls[1].url, DETAIL_URL);
});

test('Lambda rejects AudioUnion URLs outside the exact used-detail shape', async () => {
  let fetchCount = 0;
  const handler = createHandler({ env: env(), fetchFn: async () => { fetchCount += 1; throw new Error('must not fetch'); }, sleepFn: async () => {} });
  const invalidUrls = [
    'https://www.audiounion.jp/ct/search/',
    'https://www.audiounion.jp/ct/detail/new/223257/',
    'https://www.audiounion.jp/ct/detail/used/not-a-number/',
    'https://www.audiounion.jp/ct/detail/used/223257/?foo=bar',
    'https://www.audiounion.jp/ct/detail/used/223257/#fragment',
    'https://user@www.audiounion.jp/ct/detail/used/223257/',
    'https://www.audiounion.jp:444/ct/detail/used/223257/'
  ];

  for (const url of invalidUrls) {
    const result = await handler(event({ url }));
    assert.equal(result.statusCode, 400);
    assert.equal(JSON.parse(result.body).error, 'target_not_allowed');
  }
  assert.equal(fetchCount, 0);
});

test('Lambda rejects non-listing Hifido URLs', async () => {
  let fetchCount = 0;
  const handler = createHandler({ env: env(), fetchFn: async () => { fetchCount += 1; throw new Error('must not fetch'); }, sleepFn: async () => {} });
  const invalidUrls = [
    'https://www.hifido.co.jp/26-50215-14039-00.html',
    'https://www.hifido.co.jp/?L=50&LNG=J&O=1&OD=0',
    'https://www.hifido.co.jp/?L=50&LNG=J&O=0&OD=0&KW=test'
  ];
  for (const url of invalidUrls) {
    const result = await handler(event({ url }));
    assert.equal(result.statusCode, 400);
    assert.equal(JSON.parse(result.body).error, 'target_not_allowed');
  }
  assert.equal(fetchCount, 0);
});

test('Lambda respects robots crawl-delay and returns upstream HTML bytes', async () => {
  const calls = [];
  const sleeps = [];
  const html = '<html><body>AudioUnion 中古</body></html>';
  const handler = createHandler({
    env: env(),
    sleepFn: async ms => { sleeps.push(ms); },
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /st/\nCrawl-delay: 12\n', { status: 200 });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  });
  const result = await handler(event({ url: ENTRY_URL, userAgent: 'HiFiScoutBot/0.1', requestDelayMs: 5000 }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.isBase64Encoded, true);
  assert.equal(Buffer.from(result.body, 'base64').toString('utf8'), html);
  assert.equal(result.headers['x-hifiscout-upstream-status'], '200');
  assert.equal(result.headers['x-hifiscout-aws-region'], 'ap-northeast-1');
  assert.deepEqual(sleeps, [12000]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers['User-Agent'], 'HiFiScoutBot/0.1');
});

test('Lambda permits Hifido listing fetches through the Tokyo relay', async () => {
  const calls = [];
  const html = '<html><body><div class="list-item">ハイファイ堂</div></body></html>';
  const handler = createHandler({
    env: env({ MIN_REQUEST_DELAY_MS: '0' }),
    sleepFn: async () => {},
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /\n', { status: 200 });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  });
  const result = await handler(event({ url: HIFIDO_URL }));
  assert.equal(result.statusCode, 200);
  assert.equal(Buffer.from(result.body, 'base64').toString('utf8'), html);
  assert.equal(calls[0].url, 'https://www.hifido.co.jp/robots.txt');
  assert.equal(calls[1].url, HIFIDO_URL);
});

test('Lambda refuses an explicitly disallowed AudioUnion path', async () => {
  let sellerFetched = false;
  const handler = createHandler({
    env: env(),
    sleepFn: async () => {},
    fetchFn: async url => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /st/\n', { status: 200 });
      sellerFetched = true;
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
  });
  const result = await handler(event({ url: ENTRY_URL }));
  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).error, 'robots_disallowed');
  assert.equal(sellerFetched, false);
});

test('Lambda never fetches an AudioUnion detail page when robots disallows it', async () => {
  let detailFetched = false;
  const handler = createHandler({
    env: env({ MIN_REQUEST_DELAY_MS: '0' }),
    sleepFn: async () => {},
    fetchFn: async url => {
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /ct/detail/\n', { status: 200 });
      detailFetched = true;
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
  });

  const result = await handler(event({ url: DETAIL_URL }));

  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).error, 'robots_disallowed');
  assert.equal(detailFetched, false);
});
