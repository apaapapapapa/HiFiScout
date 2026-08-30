import assert from "node:assert/strict";
import { test } from "vitest";

import {
  fetchPreparedDirectHtmlPage,
  prepareDirectFetchPermit,
} from "../src/crawler/direct-pacing.js";
import {
  deliverCrawlDispatch,
  isCrawlDoCanaryEligible,
  selectedCrawlDoCanaryShops,
  shouldExecuteCrawlWithDurableObject,
} from "../src/crawler/orchestration.js";
import type { CrawlQueueMessage } from "../src/crawler/types.js";

const MESSAGE: CrawlQueueMessage = {
  shopKey: "home-shokai",
  force: true,
  requestedAt: "2026-08-30T00:00:00.000Z",
  jobId: "crawl:home-shokai:test",
  batchRunId: "batch:test",
  lane: "fast",
};

test("Phase 2 canary is an exact explicit allowlist", () => {
  assert.deepEqual(
    [...selectedCrawlDoCanaryShops(" home-shokai, ippinkan ,")],
    ["home-shokai", "ippinkan"],
  );
  assert.equal(shouldExecuteCrawlWithDurableObject("home-shokai", "home-shokai"), true);
  assert.equal(shouldExecuteCrawlWithDurableObject("home-shokai", "hifido"), false);
});

test("home-shokai is eligible while relay shops are excluded", () => {
  assert.equal(isCrawlDoCanaryEligible("home-shokai"), true);
  assert.equal(isCrawlDoCanaryEligible("hifido"), false);
  assert.equal(isCrawlDoCanaryEligible("audiounion"), false);
});

test("canary dispatch goes to the Durable Object and never the Queue", async () => {
  let queueSends = 0;
  let doFetches = 0;
  const env = {
    CRAWL_DO_CANARY_SHOPS: "home-shokai",
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

  const route = await deliverCrawlDispatch(
    env,
    MESSAGE,
    {
      send: async () => {
        queueSends += 1;
      },
    } as unknown as Parameters<typeof deliverCrawlDispatch>[2],
  );

  assert.equal(route, "durable_object");
  assert.equal(doFetches, 1);
  assert.equal(queueSends, 0);
});

test("non-canary dispatch keeps the existing Queue path", async () => {
  let queueSends = 0;
  const env = { CRAWL_DO_CANARY_SHOPS: "home-shokai" } as unknown as Env;
  const route = await deliverCrawlDispatch(
    env,
    { ...MESSAGE, shopKey: "ippinkan" },
    {
      send: async () => {
        queueSends += 1;
      },
    } as unknown as Parameters<typeof deliverCrawlDispatch>[2],
  );
  assert.equal(route, "queue");
  assert.equal(queueSends, 1);
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
