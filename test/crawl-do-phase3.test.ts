import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import {
  deliverCrawlDispatch,
  isCrawlDoCanaryEligible,
  selectedCrawlDoCanaryShops,
} from "../src/crawler/orchestration.js";
import { crawlQueueLane } from "../src/crawler/queue-lanes.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { CrawlQueueMessage } from "../src/crawler/types.js";

function plugin(shopKey: string) {
  const value = getShopPlugin(shopKey);
  assert.ok(value);
  return value;
}

test("Phase 3 heavy rollout targets the direct collectors from #391", () => {
  assert.equal(crawlQueueLane(plugin("ippinkan")), "heavy");
  assert.equal(crawlQueueLane(plugin("u-audio")), "heavy");
  assert.equal(isCrawlDoCanaryEligible("ippinkan"), true);
  assert.equal(isCrawlDoCanaryEligible("u-audio"), true);
});

test("direct seller HTTP outside the normal page path remains excluded", () => {
  // Relay-backed collectors moved onto the DO path in Phase 5. Direct collectors that still issue
  // secondary seller HTTP remain excluded until that capability has an Alarm-owned pacing seam.
  assert.equal(isCrawlDoCanaryEligible("fujiya-avic"), false);
});

test("production DO allowlist contains the Phase 3 collectors", () => {
  const wrangler = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as { vars?: { CRAWL_DO_CANARY_SHOPS?: string } };

  const selected = selectedCrawlDoCanaryShops(wrangler.vars?.CRAWL_DO_CANARY_SHOPS);
  for (const shopKey of ["home-shokai", "ippinkan", "u-audio"]) {
    assert.equal(selected.has(shopKey), true);
  }
});

test("selected heavy lane dispatch uses the Durable Object and never Queue", async () => {
  const message: CrawlQueueMessage = {
    shopKey: "u-audio",
    force: true,
    requestedAt: "2026-08-30T10:00:00.000Z",
    jobId: "crawl:u-audio:phase3",
    batchRunId: "batch:phase3",
    lane: "heavy",
  };
  let queueSends = 0;
  let doCommands = 0;
  const env = {
    CRAWL_DO_CANARY_SHOPS: "home-shokai,ippinkan,u-audio",
    CRAWL_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          doCommands += 1;
          const body = JSON.parse(String(init.body));
          assert.equal(body.type, "start_crawl");
          assert.deepEqual(body.message, message);
          return new Response(null, { status: 202 });
        },
      }),
    },
  } as unknown as Env;

  const route = await deliverCrawlDispatch(env, message, {
    send: async () => {
      queueSends += 1;
    },
  } as unknown as Parameters<typeof deliverCrawlDispatch>[2]);

  assert.equal(route, "durable_object");
  assert.equal(doCommands, 1);
  assert.equal(queueSends, 0);
});

test("heavy lane alone never opts a shop into the DO path", async () => {
  const message: CrawlQueueMessage = {
    shopKey: "avac",
    force: true,
    requestedAt: "2026-08-30T10:00:00.000Z",
    jobId: "crawl:avac:not-selected",
    batchRunId: "batch:phase3",
    lane: "heavy",
  };
  assert.equal(crawlQueueLane(plugin("avac")), "heavy");
  assert.equal(isCrawlDoCanaryEligible("avac"), true);

  let queueSends = 0;
  const env = { CRAWL_DO_CANARY_SHOPS: "home-shokai,ippinkan,u-audio" } as unknown as Env;
  const route = await deliverCrawlDispatch(env, message, {
    send: async () => {
      queueSends += 1;
    },
  } as unknown as Parameters<typeof deliverCrawlDispatch>[2]);

  assert.equal(route, "queue");
  assert.equal(queueSends, 1);
});
