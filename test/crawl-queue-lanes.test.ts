import test from "node:test";
import assert from "node:assert/strict";

import {
  crawlQueueLane,
  isCrawlDeadLetterQueueName,
  isCrawlQueueName,
} from "../src/crawler/queue-lanes.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";

function shop(key: string) {
  const plugin = getShopPlugin(key);
  assert.ok(plugin, key);
  return plugin;
}

test("relay collectors are isolated from direct collectors", () => {
  assert.equal(crawlQueueLane(shop("audiounion")), "relay");
  assert.equal(crawlQueueLane(shop("hifido")), "relay");
});

test("broad direct inventories use the heavy lane while small collectors stay fast", () => {
  assert.equal(crawlQueueLane(shop("fujiya-avic")), "heavy");
  assert.equal(crawlQueueLane(shop("u-audio")), "heavy");
  assert.equal(crawlQueueLane(shop("home-shokai")), "fast");
  assert.equal(crawlQueueLane(shop("ippinkan")), "fast");
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
