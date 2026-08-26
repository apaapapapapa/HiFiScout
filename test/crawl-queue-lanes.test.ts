import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  crawlQueueLane,
  isCrawlDeadLetterQueueName,
  isCrawlQueueName,
} from "../src/crawler/queue-lanes.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { defineShopPlugin } from "../src/crawler/shops/registry.js";
import type { CrawlWorkloadObservation } from "../src/db/crawl-workload-repository.js";
import type { ShopAdapter } from "../src/crawler/types.js";

function observed(overrides: Partial<CrawlWorkloadObservation> = {}): CrawlWorkloadObservation {
  return {
    shopKey: "home-shokai",
    peakItemCount: 0,
    budgetExhaustedCount: 0,
    lastBudgetExhaustedAt: null,
    ...overrides,
  };
}

function shop(key: string) {
  const plugin = getShopPlugin(key);
  assert.ok(plugin, key);
  return plugin;
}

/** No registered shop currently declares no page cap and no discovery, so it is built here. */
function uncappedPlugin(discovery: Partial<ShopAdapter["discovery"]>) {
  const adapter: ShopAdapter = {
    key: "example-shop",
    name: "Example Shop",
    baseUrl: "https://example.com",
    discovery: {
      coverage: "unknown",
      policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },
      *initialTargets() {},
      ...discovery,
    },
    parse: () => [],
  };
  return defineShopPlugin(adapter, {
    key: adapter.key,
    name: adapter.name,
    baseUrl: adapter.baseUrl,
    defaultIntervalMinutes: 60,
  });
}

test("relay collectors are isolated from direct collectors", () => {
  assert.equal(crawlQueueLane(shop("audiounion")), "relay");
  assert.equal(crawlQueueLane(shop("hifido")), "relay");
});

test("broad direct inventories use the heavy lane while small collectors stay fast", () => {
  assert.equal(crawlQueueLane(shop("fujiya-avic")), "heavy");
  assert.equal(crawlQueueLane(shop("u-audio")), "heavy");
  assert.equal(crawlQueueLane(shop("home-shokai")), "fast");
});

test("a shop that can discover pages without declaring a cap is not treated as small", () => {
  // Ippinkan declares no page budget and follows the storefront's own pagination, so it inherits
  // the deployment-wide cap rather than a cap of zero. Reading the absent value as a small
  // inventory is what put a seventeen-page crawl in the fast lane.
  const ippinkan = shop("ippinkan");
  assert.equal(ippinkan.definition.defaultMaxPages, undefined);
  assert.ok(ippinkan.discovery.discoverTargets);
  assert.equal(crawlQueueLane(ippinkan), "heavy");

  // Absence only stays safe when the shop cannot reach past its seeded targets at all.
  assert.equal(crawlQueueLane(uncappedPlugin({ discoverTargets: undefined })), "fast");
  assert.equal(crawlQueueLane(uncappedPlugin({ discoverTargets: () => [] })), "heavy");
});

test("a shop that turned out to be large is scheduled from what it cost, not what it declares", () => {
  const small = shop("home-shokai");
  assert.equal(crawlQueueLane(small), "fast");
  assert.equal(crawlQueueLane(small, null), "fast", "a shop with no history keeps its declaration");

  assert.equal(crawlQueueLane(small, observed({ peakItemCount: 745 })), "heavy");
  // Handing derived work to the continuation sweep is the direct evidence that one invocation was
  // not enough, so it promotes on its own without waiting for an inventory threshold.
  assert.equal(crawlQueueLane(small, observed({ budgetExhaustedCount: 1 })), "heavy");
});

test("observed workload never demotes a lane and never overrides the relay transport", () => {
  // Both signals are high-water marks, so a quiet crawl after a large one cannot flap the shop back
  // into the pool it outgrew.
  assert.equal(crawlQueueLane(shop("fujiya-avic"), observed({ peakItemCount: 1 })), "heavy");
  assert.equal(crawlQueueLane(shop("hifido"), observed({ peakItemCount: 100_000 })), "relay");
});

test("new crawl queues and rollout legacy queues are routed explicitly", () => {
  for (const queue of [
    "hifiscout-crawl",
    "hifiscout-crawl-fast",
    "hifiscout-crawl-heavy",
    "hifiscout-crawl-relay",
  ]) {
    assert.equal(isCrawlQueueName(queue), true, queue);
  }
  for (const queue of [
    "hifiscout-crawl-dlq",
    "hifiscout-crawl-fast-dlq",
    "hifiscout-crawl-heavy-dlq",
    "hifiscout-crawl-relay-dlq",
  ]) {
    assert.equal(isCrawlDeadLetterQueueName(queue), true, queue);
  }
  assert.equal(isCrawlQueueName("hifiscout-knowledge-verification"), false);
});
