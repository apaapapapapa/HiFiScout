import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { fetchRobotsPolicy, getCrawlDelayMs, isPathAllowed } from "../src/crawler/robots.js";

test("robots longest matching rule wins", () => {
  const robots = `User-agent: *\nDisallow: /shop/\nAllow: /shop/r/`;
  assert.equal(isPathAllowed(robots, "https://example.com/shop/r/used", "HiFiScoutBot"), true);
  assert.equal(isPathAllowed(robots, "https://example.com/shop/private", "HiFiScoutBot"), false);
});

test("robots terminal anchors match only the complete path", () => {
  const robots = `User-agent: *\nDisallow: /catalog$`;
  assert.equal(isPathAllowed(robots, "https://example.com/catalog", "HiFiScoutBot"), false);
  assert.equal(isPathAllowed(robots, "https://example.com/catalog/item", "HiFiScoutBot"), true);
});

test("robots crawl-delay is parsed for the applicable user-agent", () => {
  const robots = `User-agent: *\nCrawl-delay: 10\nDisallow: /ct/search*`;
  assert.equal(getCrawlDelayMs(robots, "HiFiScoutBot/0.1"), 10_000);
});

test("robots 403 is treated as unavailable rather than an explicit disallow", async () => {
  const policy = await fetchRobotsPolicy(
    async () => new Response("Forbidden", { status: 403 }),
    "https://example.com",
    "HiFiScoutBot/0.1",
  );
  assert.equal(policy, null);
});

test("robots 429 remains a temporary backoff signal", async () => {
  await assert.rejects(
    fetchRobotsPolicy(
      async () => new Response("Too Many Requests", { status: 429 }),
      "https://example.com",
      "HiFiScoutBot/0.1",
    ),
    /temporarily unavailable \(429\)/,
  );
});

test("robots 5xx remains a temporary backoff signal", async () => {
  await assert.rejects(
    fetchRobotsPolicy(
      async () => new Response("Unavailable", { status: 503 }),
      "https://example.com",
      "HiFiScoutBot/0.1",
    ),
    /temporarily unavailable \(503\)/,
  );
});
