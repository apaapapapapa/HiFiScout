import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  deliverCrawlDispatch,
  isCrawlDoEligible,
  type CrawlDispatchMessage,
} from "../src/crawler/orchestration.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";

function plugin(shopKey: string) {
  const value = getShopPlugin(shopKey);
  assert.ok(value);
  return value;
}

function schedulerEnv(onMessage: (message: CrawlDispatchMessage) => void): Env {
  return {
    CRAWL_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as {
            type: string;
            message: CrawlDispatchMessage;
          };
          assert.equal(body.type, "start_crawl");
          onMessage(body.message);
          return new Response(null, { status: 202 });
        },
      }),
    },
  } as unknown as Env;
}

test("Phase 3 direct collectors remain DO eligible after Queue removal", () => {
  assert.ok(plugin("ippinkan"));
  assert.ok(plugin("u-audio"));
  assert.equal(isCrawlDoEligible("ippinkan"), true);
  assert.equal(isCrawlDoEligible("u-audio"), true);
});

test("Fujiya direct detail collector is DO eligible", () => {
  assert.equal(isCrawlDoEligible("fujiya-avic"), true);
});

test("former heavy collector dispatch uses the Durable Object", async () => {
  const message: CrawlDispatchMessage = {
    shopKey: "u-audio",
    force: true,
    requestedAt: "2026-08-30T10:00:00.000Z",
    jobId: "crawl:u-audio:phase3",
    batchRunId: "batch:phase3",
  };
  const delivered: CrawlDispatchMessage[] = [];

  const route = await deliverCrawlDispatch(
    schedulerEnv((body) => delivered.push(body)),
    message,
  );

  assert.equal(route, "durable_object");
  assert.deepEqual(delivered, [message]);
});

test("another direct shop uses DO without a rollout allowlist", async () => {
  const message: CrawlDispatchMessage = {
    shopKey: "avac",
    force: true,
    requestedAt: "2026-08-30T10:00:00.000Z",
    jobId: "crawl:avac:phase7",
    batchRunId: "batch:phase7",
  };
  assert.equal(isCrawlDoEligible("avac"), true);
  const delivered: CrawlDispatchMessage[] = [];

  const route = await deliverCrawlDispatch(
    schedulerEnv((body) => delivered.push(body)),
    message,
  );

  assert.equal(route, "durable_object");
  assert.deepEqual(delivered, [message]);
});
