import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { deliverCrawlDispatch, isCrawlDoCanaryEligible } from "../src/crawler/orchestration.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { CrawlQueueMessage } from "../src/crawler/types.js";

function plugin(shopKey: string) {
  const value = getShopPlugin(shopKey);
  assert.ok(value);
  return value;
}

function schedulerEnv(onMessage: (message: CrawlQueueMessage) => void): Env {
  return {
    CRAWL_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { type: string; message: CrawlQueueMessage };
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
  assert.equal(isCrawlDoCanaryEligible("ippinkan"), true);
  assert.equal(isCrawlDoCanaryEligible("u-audio"), true);
});

test("Fujiya direct detail collector is DO eligible in Phase 6", () => {
  assert.equal(isCrawlDoCanaryEligible("fujiya-avic"), true);
});

test("former heavy collector dispatch uses the Durable Object", async () => {
  const message: CrawlQueueMessage = {
    shopKey: "u-audio",
    force: true,
    requestedAt: "2026-08-30T10:00:00.000Z",
    jobId: "crawl:u-audio:phase3",
    batchRunId: "batch:phase3",
  };
  const delivered: CrawlQueueMessage[] = [];

  const route = await deliverCrawlDispatch(schedulerEnv((body) => delivered.push(body)), message);

  assert.equal(route, "durable_object");
  assert.deepEqual(delivered, [message]);
});

test("another direct shop uses DO without a rollout allowlist", async () => {
  const message: CrawlQueueMessage = {
    shopKey: "avac",
    force: true,
    requestedAt: "2026-08-30T10:00:00.000Z",
    jobId: "crawl:avac:phase6",
    batchRunId: "batch:phase6",
  };
  assert.equal(isCrawlDoCanaryEligible("avac"), true);
  const delivered: CrawlQueueMessage[] = [];

  const route = await deliverCrawlDispatch(schedulerEnv((body) => delivered.push(body)), message);

  assert.equal(route, "durable_object");
  assert.deepEqual(delivered, [message]);
});
