import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import {
  prepareShopInventoryRecheck,
  recheckShopInventory,
} from "../src/crawler/inventory-recheck.js";
import {
  deliverCrawlDispatch,
  isCrawlDoCanaryEligible,
  selectedCrawlDoCanaryShops,
} from "../src/crawler/orchestration.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { InventoryRecheckCandidateRow } from "../src/db/types.js";
import type { CrawlQueueMessage } from "../src/crawler/types.js";

const DETAIL_URL = "https://www.audiounion.jp/ct/detail/used/223257/";

function plugin(shopKey: string) {
  const value = getShopPlugin(shopKey);
  assert.ok(value);
  return value;
}

function candidate(): InventoryRecheckCandidateRow {
  return {
    id: 123,
    source_id: "223257",
    source_url: DETAIL_URL,
    last_seen_at: "2026-08-30T00:00:00.000Z",
    last_inventory_checked_at: null,
    inventory_check_failures: 0,
  } as unknown as InventoryRecheckCandidateRow;
}

function inventoryEnv() {
  return {
    DB: {},
    AUDIOUNION_INVENTORY_RECHECK_ENABLED: "true",
    AUDIOUNION_INVENTORY_RECHECK_MIN_AGE_HOURS: "24",
    AUDIOUNION_INVENTORY_RECHECK_INTERVAL_HOURS: "24",
    AUDIOUNION_INVENTORY_RECHECK_FAILURE_THRESHOLD: "2",
    AUDIOUNION_REQUEST_DELAY_MS: "10000",
    CRAWLER_USER_AGENT: "HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)",
  } as unknown as Env;
}

test("Phase 5 makes both Relay-backed collectors DO eligible", () => {
  assert.equal(plugin("audiounion").capabilities.transport?.kind, "relay");
  assert.equal(plugin("hifido").capabilities.transport?.kind, "relay");
  assert.equal(isCrawlDoCanaryEligible("audiounion"), true);
  assert.equal(isCrawlDoCanaryEligible("hifido"), true);
  assert.equal(isCrawlDoCanaryEligible("fujiya-avic"), false);
});

test("production Phase 5 allowlist includes Audio Union and Hifido", () => {
  const wrangler = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as { vars?: { CRAWL_DO_CANARY_SHOPS?: string } };

  assert.deepEqual(
    [...selectedCrawlDoCanaryShops(wrangler.vars?.CRAWL_DO_CANARY_SHOPS)],
    ["home-shokai", "ippinkan", "u-audio", "audiounion", "hifido"],
  );
});

test("selected relay lane dispatch bypasses Queue", async () => {
  const message: CrawlQueueMessage = {
    shopKey: "hifido",
    force: true,
    requestedAt: "2026-09-01T14:30:00.000Z",
    jobId: "crawl:hifido:phase5",
    batchRunId: "batch:phase5",
    lane: "relay",
  };
  let queueSends = 0;
  let doCommands = 0;
  const env = {
    CRAWL_DO_CANARY_SHOPS: "home-shokai,ippinkan,u-audio,audiounion,hifido",
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

test("relay lane alone does not opt an unselected shop into the DO path", async () => {
  const message: CrawlQueueMessage = {
    shopKey: "hifido",
    force: true,
    requestedAt: "2026-09-01T14:31:00.000Z",
    jobId: "crawl:hifido:phase5-unselected",
    batchRunId: "batch:phase5",
    lane: "relay",
  };
  let queueSends = 0;
  const env = {
    CRAWL_DO_CANARY_SHOPS: "home-shokai,ippinkan,u-audio,audiounion",
  } as unknown as Env;

  const route = await deliverCrawlDispatch(env, message, {
    send: async () => {
      queueSends += 1;
    },
  } as unknown as Parameters<typeof deliverCrawlDispatch>[2]);

  assert.equal(route, "queue");
  assert.equal(queueSends, 1);
});

test("inventory PREPARE discovery is read-only until the paced FETCH alarm", async () => {
  const audioUnion = plugin("audiounion");
  let attempts = 0;
  const repository = {
    selectInventoryRecheckCandidate: async () => candidate(),
    markInventoryCheckAttempt: async () => {
      attempts += 1;
    },
    markInventoryAvailable: async () => {},
    markInventoryAmbiguous: async () => {},
    recordInventoryUnavailable: async () => {},
  };

  const preparation = await prepareShopInventoryRecheck(inventoryEnv(), audioUnion, {
    now: new Date("2026-09-01T14:30:00.000Z"),
    repository,
  });

  assert.deepEqual(preparation, {
    status: "ready",
    targetUrl: DETAIL_URL,
    userAgent: "HiFiScoutBot/0.1 (+https://github.com/apaapapapapa/HiFiScout)",
    requestDelayMs: 10000,
  });
  assert.equal(attempts, 0);
});

test("inventory recheck accepts the scheduler prepared FETCH seam without Relay config", async () => {
  const audioUnion = plugin("audiounion");
  let attempts = 0;
  let available = 0;
  let fetches = 0;
  const repository = {
    selectInventoryRecheckCandidate: async () => candidate(),
    markInventoryCheckAttempt: async () => {
      attempts += 1;
    },
    markInventoryAvailable: async () => {
      available += 1;
    },
    markInventoryAmbiguous: async () => {},
    recordInventoryUnavailable: async () => {},
  };

  const result = await recheckShopInventory(inventoryEnv(), audioUnion, {
    now: new Date("2026-09-01T14:30:10.000Z"),
    repository,
    fetchPage: async (url, options) => {
      fetches += 1;
      assert.equal(url, DETAIL_URL);
      assert.equal(options.requestDelayMs, 10000);
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<main>販売価格 <strong>¥798,000</strong></main>",
      };
    },
  });

  assert.equal(result.status, "checked");
  if (result.status === "checked") assert.equal(result.outcome, "in_stock");
  assert.equal(fetches, 1);
  assert.equal(attempts, 1);
  assert.equal(available, 1);
});

test("Hifido detail enrichment is owned by the same Relay Alarm pacing authority", () => {
  const scheduler = readFileSync(
    new URL("../src/crawler/crawl-scheduler-do.ts", import.meta.url),
    "utf8",
  );
  const finalizer = readFileSync(
    new URL("../src/crawler/resumable-finalize.ts", import.meta.url),
    "utf8",
  );

  assert.match(scheduler, /planStagedCategoryDetailFetches/);
  assert.match(scheduler, /detailTargetUrl/);
  assert.match(scheduler, /recordCrawlFetchDetailPage/);
  assert.match(finalizer, /getCrawlFetchDetailPage/);
  assert.match(finalizer, /category detail fetch was not paced by CrawlScheduler/);
});

test("Phase 5 scheduler has no active waiting primitive", () => {
  const source = readFileSync(
    new URL("../src/crawler/crawl-scheduler-do.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /prepareRelayFetchPermit/);
  assert.match(source, /fetchPreparedRelayHtmlPage/);
  assert.match(source, /fetchPreparedRelayPage/);
  assert.match(source, /prepareShopInventoryRecheck/);
  assert.doesNotMatch(source, /\bsleep\s*\(/);
  assert.doesNotMatch(source, /\bsetTimeout\s*\(/);
});
