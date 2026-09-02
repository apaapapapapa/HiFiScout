import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import { isCrawlDoEligible } from "../src/crawler/orchestration.js";

test("Phase 1 shadow rollout control path remains retired", () => {
  const orchestration = readFileSync(
    new URL("../src/crawler/orchestration.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(orchestration, /observe_checkpoint/);
  assert.doesNotMatch(orchestration, /CRAWL_SCHEDULER_OBSERVE_PATH/);
  assert.doesNotMatch(orchestration, /selectedCrawlDoShadowShops/);
  assert.doesNotMatch(orchestration, /shouldObserveCrawlWithDurableObject/);
  assert.match(orchestration, /CRAWL_SCHEDULER_START_PATH/);
});

test("final orchestration eligibility is derived from the registered shop transport", () => {
  assert.equal(isCrawlDoEligible("home-shokai"), true);
  assert.equal(isCrawlDoEligible("ippinkan"), true);
  assert.equal(isCrawlDoEligible("hifido"), true);
  assert.equal(isCrawlDoEligible("unknown-shop"), false);
});
