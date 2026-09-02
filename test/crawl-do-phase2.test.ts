import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  fetchPreparedDirectHtmlPage,
  prepareDirectFetchPermit,
} from "../src/crawler/direct-pacing.js";
import {
  deliverCrawlDispatch,
  isCrawlDoEligible,
  type CrawlDispatchMessage,
} from "../src/crawler/orchestration.js";

const MESSAGE: CrawlDispatchMessage = {
  shopKey: "home-shokai",
  force: true,
  requestedAt: "2026-08-30T00:00:00.000Z",
  jobId: "crawl:home-shokai:test",
  batchRunId: "batch:test",
};

test("Phase 7 routes registered crawl shops through the Durable Object without rollout allowlists", () => {
  assert.equal(isCrawlDoEligible("home-shokai"), true);
  assert.equal(isCrawlDoEligible("hifido"), true);
  assert.equal(isCrawlDoEligible("unknown-shop"), false);
});

test("direct crawl dispatch goes to the Durable Object", async () => {
  let doFetches = 0;
  const env = {
    CRAWL_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          doFetches += 1;
          const body = JSON.parse(String(init.body));
          assert.equal(body.type, "start_crawl");
          assert.deepEqual(body.message, MESSAGE);
          return new Response(null, { status: 202 });
        },
      }),
    },
  } as unknown as Env;

  const route = await deliverCrawlDispatch(env, MESSAGE);

  assert.equal(route, "durable_object");
  assert.equal(doFetches, 1);
});

test("unknown shops are rejected before a Durable Object dispatch", async () => {
  await assert.rejects(
    deliverCrawlDispatch({} as Env, { ...MESSAGE, shopKey: "unknown-shop" }),
    /not eligible for DO execution/,
  );
});

test("direct permit preserves robots -> wait -> target without sleeping", async () => {
  const requests: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nCrawl-delay: 2\nAllow: /", { status: 200 });
    }
    return new Response("<html>ok</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;

  const permit = await prepareDirectFetchPermit("https://example.test/items", {
    baseUrl: "https://example.test",
    userAgent: "HiFiScoutBot/0.1",
    requestDelayMs: 1500,
    fetchFn,
    nowMs: 1000,
  });
  assert.equal(permit.effectiveDelayMs, 2000);
  assert.equal(permit.notBeforeMs, 3000);
  assert.deepEqual(requests, ["https://example.test/robots.txt"]);

  await assert.rejects(
    fetchPreparedDirectHtmlPage(permit, permit.targetUrl, {
      userAgent: permit.userAgent,
      fetchFn,
      nowMs: 2999,
    }),
    /not ready/,
  );
  assert.equal(requests.length, 1);

  const html = await fetchPreparedDirectHtmlPage(permit, permit.targetUrl, {
    userAgent: permit.userAgent,
    fetchFn,
    nowMs: 3000,
  });
  assert.equal(html, "<html>ok</html>");
  assert.deepEqual(requests, ["https://example.test/robots.txt", "https://example.test/items"]);
});
