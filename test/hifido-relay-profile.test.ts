import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../infra/audiounion-lambda/index.js";

const HIFIDO_URL = "https://www.hifido.co.jp/?L=50&LNG=J&O=0&OD=0";
const TOKEN = `test-${"x".repeat(40)}`;

function event(body = {}) {
  return {
    headers: { authorization: `Bearer ${TOKEN}` },
    requestContext: { http: { method: "POST" } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function env(overrides = {}) {
  return {
    RELAY_TOKEN: TOKEN,
    AUDIOUNION_ENTRY_URL: "https://www.audiounion.jp/st/new_arrival_used.html",
    CRAWLER_USER_AGENT: "HiFiScoutBot/0.1",
    MIN_REQUEST_DELAY_MS: "0",
    AWS_REGION: "ap-northeast-1",
    ...overrides,
  };
}

test("Hifido relay uses a browser-compatible request profile while retaining crawler identity", async () => {
  const calls: Array<{ url: string; options: { headers: Record<string, string> } }> = [];
  const handler = createHandler({
    env: env(),
    sleepFn: async () => {},
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/robots.txt"))
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      return new Response("<html><body>ハイファイ堂</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  const result = await handler(event({ url: HIFIDO_URL, userAgent: "HiFiScoutBot/0.1" }));

  assert.equal(result.statusCode, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.headers["User-Agent"], /^Mozilla\/5\.0/);
  assert.match(calls[0].options.headers["User-Agent"], /HiFiScoutBot\/0\.1/);
  assert.equal(calls[1].options.headers["Referer"], "https://www.hifido.co.jp/");
  assert.equal(calls[1].options.headers["Sec-Fetch-Mode"], "navigate");
  assert.equal(calls[1].options.headers["Upgrade-Insecure-Requests"], "1");
});

test("Hifido relay user agent can be overridden without allowing header injection", async () => {
  const calls: Array<{ url: string; options: { headers: Record<string, string> } }> = [];
  const customAgent = "Mozilla/5.0 HiFiScoutBot/0.2";
  const handler = createHandler({
    env: env({ HIFIDO_USER_AGENT: customAgent }),
    sleepFn: async () => {},
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/robots.txt"))
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      return new Response("<html></html>", { status: 200 });
    },
  });

  const result = await handler(event({ url: HIFIDO_URL }));
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].options.headers["User-Agent"], customAgent);
  assert.equal(calls[1].options.headers["User-Agent"], customAgent);
});
