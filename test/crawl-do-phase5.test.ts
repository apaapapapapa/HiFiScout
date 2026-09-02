import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import {
  prepareShopInventoryRecheck,
  recheckShopInventory,
} from "../src/crawler/inventory-recheck.js";
import {
  deliverCrawlDispatch,
  isCrawlDoEligible,
  type CrawlDispatchMessage,
} from "../src/crawler/orchestration.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { InventoryRecheckCandidateRow } from "../src/db/types.js";

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

test("Phase 5 Relay collectors and direct-detail collectors are DO eligible", () => {
  assert.equal(plugin("audiounion").capabilities.transport?.kind, "relay");
  assert.equal(plugin("hifido").capabilities.transport?.kind, "relay");
  assert.equal(isCrawlDoEligible("audiounion"), true);
  assert.equal(isCrawlDoEligible("hifido"), true);
  assert.equal(isCrawlDoEligible("fujiya-avic"), true);
});

test("Phase 7 no longer needs a production DO rollout allowlist", () => {
  const wrangler = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as { vars?: { CRAWL_DO_CANARY_SHOPS?: string } };

  assert.equal(wrangler.vars?.CRAWL_DO_CANARY_SHOPS, undefined);
});

test("relay collector dispatch goes directly to the Durable Object", async () => {
  const message: CrawlDispatchMessage = {
    shopKey: "hifido",
    force: true,
    requestedAt: "2026-09-01T14:30:00.000Z",
    jobId: "crawl:hifido:phase5",
    batchRunId: "batch:phase5",
  };
  const delivered: CrawlDispatchMessage[] = [];

  const route = await deliverCrawlDispatch(
    schedulerEnv((body) => delivered.push(body)),
    message,
  );

  assert.equal(route, "durable_object");
  assert.deepEqual(delivered, [message]);
});

test("legacy rollout configuration no longer disables a Relay collector", async () => {
  const message: CrawlDispatchMessage = {
    shopKey: "hifido",
    force: true,
    requestedAt: "2026-09-01T14:31:00.000Z",
    jobId: "crawl:hifido:phase7",
    batchRunId: "batch:phase7",
  };
  const delivered: CrawlDispatchMessage[] = [];
  const env = schedulerEnv((body) => delivered.push(body)) as Env & {
    CRAWL_DO_CANARY_SHOPS?: string;
  };
  env.CRAWL_DO_CANARY_SHOPS = "home-shokai,ippinkan,u-audio,audiounion";

  const route = await deliverCrawlDispatch(env, message);

  assert.equal(route, "durable_object");
  assert.deepEqual(delivered, [message]);
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

  assert.equal(preparation.status, "ready");
  if (preparation.status === "ready") {
    assert.equal(preparation.targetUrl, DETAIL_URL);
    assert.equal(preparation.requestDelayMs, 10000);
    assert.match(preparation.userAgent, /^HiFiScoutBot\/0\.1/);
  }
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

test("Phase 5 detail staging reuses the migration-0065 crawl frontier", () => {
  const repository = readFileSync(
    new URL("../src/db/crawl-fetch-detail-repository.ts", import.meta.url),
    "utf8",
  );
  assert.match(repository, /INSERT OR IGNORE INTO crawl_fetch_pages/);
  assert.match(repository, /state = 'ignored'/);
  assert.doesNotMatch(repository, /crawl_fetch_detail_pages/);
  assert.equal(
    existsSync(new URL("../migrations/0071_crawl_fetch_detail_pacing.sql", import.meta.url)),
    false,
  );
});

test("production deploy skips D1 only when no migrations changed since last success", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /actions\/workflows\/deploy\.yml\/runs\?branch=main&status=success/);
  assert.match(workflow, /--diff-filter=AM/);
  assert.match(workflow, /steps\.d1-migrations\.outputs\.required == 'true'/);
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
