import test from "node:test";
import assert from "node:assert/strict";
import { recheckShopInventory } from "../src/crawler/inventory-recheck.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { CrawlerEnv, ShopPlugin } from "../src/crawler/types.js";
import type { InventoryRecheckCandidateRow, QueryableDatabase } from "../src/db/types.js";
import { asQueryableDatabase } from "./helpers/d1.js";

const NOW = new Date("2026-08-11T10:00:00.000Z");
const DETAIL_URL = "https://www.audiounion.jp/ct/detail/used/223257/";

const audioUnion = getShopPlugin("audiounion") as ShopPlugin;

type RecheckEnv = Parameters<typeof recheckShopInventory>[0];
type RecheckOptions = Parameters<typeof recheckShopInventory>[2];

/** The loop under test is shop-agnostic; AudioUnion is simply the shop that opts in today. */
function recheck(env: RecheckEnv, options?: RecheckOptions) {
  return recheckShopInventory(env, audioUnion, options);
}

function env(overrides: Partial<CrawlerEnv> = {}) {
  return {
    DB: asQueryableDatabase({}),
    CRAWL_RELAY_URL: "https://relay.example/",
    CRAWL_RELAY_TOKEN: "test-relay-token",
    CRAWLER_USER_AGENT: "HiFiScoutBot/0.1",
    AUDIOUNION_REQUEST_DELAY_MS: "0",
    AUDIOUNION_INVENTORY_RECHECK_ENABLED: "true",
    AUDIOUNION_INVENTORY_RECHECK_MIN_AGE_HOURS: "24",
    AUDIOUNION_INVENTORY_RECHECK_INTERVAL_HOURS: "24",
    AUDIOUNION_INVENTORY_RECHECK_FAILURE_THRESHOLD: "2",
    ...overrides,
  };
}

function candidate(
  overrides: Partial<InventoryRecheckCandidateRow> = {},
): InventoryRecheckCandidateRow {
  return {
    id: 7,
    source_id: "223257",
    source_url: DETAIL_URL,
    last_seen_at: "2026-08-09T08:00:00.000Z",
    last_inventory_checked_at: null,
    last_inventory_check_attempt_at: null,
    inventory_check_failures: 0,
    ...overrides,
  };
}

function fakeRepository(selected: InventoryRecheckCandidateRow | null = candidate()) {
  const calls: unknown[][] = [];
  const repository = {
    calls,
    async selectInventoryRecheckCandidate(
      _db: QueryableDatabase,
      shopKey: string,
      options: { staleBefore: string; retryBefore: string },
    ) {
      calls.push(["select", shopKey, options]);
      return selected;
    },
    async markInventoryCheckAttempt(
      _db: QueryableDatabase,
      productId: number,
      attemptedAt: string,
    ) {
      const args = [productId, attemptedAt];
      calls.push(["attempt", ...args]);
    },
    async markInventoryAvailable(_db: QueryableDatabase, productId: number, checkedAt: string) {
      const args = [productId, checkedAt];
      calls.push(["available", ...args]);
    },
    async markInventoryAmbiguous(_db: QueryableDatabase, productId: number, checkedAt: string) {
      const args = [productId, checkedAt];
      calls.push(["ambiguous", ...args]);
    },
    async recordInventoryUnavailable(
      _db: QueryableDatabase,
      productId: number,
      checkedAt: string,
      failureCount: number,
      deactivate: boolean,
    ) {
      const args = [productId, checkedAt, failureCount, deactivate];
      calls.push(["unavailable", ...args]);
    },
  };
  return repository;
}

function upstreamResponse(
  body: BodyInit,
  status = 200,
  contentType = "text/html; charset=utf-8",
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "x-hifiscout-upstream-status": String(status),
    },
  });
}

test("a shop that declares no recheck policy is skipped without touching the database", async () => {
  const repository = fakeRepository();
  const plain = getShopPlugin("ippinkan") as ShopPlugin;
  assert.equal(plain.capabilities.inventoryRecheck, undefined);

  const result = await recheckShopInventory(env(), plain, { now: NOW, repository });

  assert.deepEqual(result, { status: "skipped", reason: "disabled" });
  assert.equal(repository.calls.length, 0);
});

test("recheck marks an explicitly priced detail page as available", async () => {
  const repository = fakeRepository();
  const result = await recheck(env(), {
    now: NOW,
    repository,
    fetchFn: async () => upstreamResponse("<html><body>販売価格 <b>¥798,000</b></body></html>"),
  });

  assert.equal(result.status, "checked");
  assert.equal(result.outcome, "in_stock");
  assert.deepEqual(repository.calls[0], [
    "select",
    "audiounion",
    {
      staleBefore: "2026-08-10T10:00:00.000Z",
      retryBefore: "2026-08-10T10:00:00.000Z",
    },
  ]);
  assert.deepEqual(repository.calls[1], ["attempt", 7, NOW.toISOString()]);
  assert.deepEqual(repository.calls[2], ["available", 7, NOW.toISOString()]);
});

test("first explicit sold page records unavailable evidence but keeps the product active", async () => {
  const repository = fakeRepository();
  const result = await recheck(env(), {
    now: NOW,
    repository,
    fetchFn: async () => upstreamResponse("<html><body>この商品は販売終了しました</body></html>"),
  });

  assert.equal(result.status, "checked");
  assert.equal(result.outcome, "sold_retry");
  assert.equal(result.failureCount, 1);
  assert.deepEqual(repository.calls.at(-1), ["unavailable", 7, NOW.toISOString(), 1, false]);
});

test("second consecutive explicit sold page deactivates the product", async () => {
  const repository = fakeRepository(
    candidate({
      last_inventory_checked_at: "2026-08-10T08:00:00.000Z",
      inventory_check_failures: 1,
    }),
  );
  const result = await recheck(env(), {
    now: NOW,
    repository,
    fetchFn: async () => upstreamResponse("<html><body>販売終了</body></html>"),
  });

  assert.equal(result.outcome, "sold_deactivated");
  assert.equal(result.failureCount, 2);
  assert.deepEqual(repository.calls.at(-1), ["unavailable", 7, NOW.toISOString(), 2, true]);
});

test("first 404 records unavailable evidence but keeps the product active", async () => {
  const repository = fakeRepository();
  const result = await recheck(env(), {
    now: NOW,
    repository,
    fetchFn: async () => upstreamResponse("<html>not found</html>", 404),
  });

  assert.equal(result.outcome, "missing_retry");
  assert.equal(result.failureCount, 1);
  assert.deepEqual(repository.calls.at(-1), ["unavailable", 7, NOW.toISOString(), 1, false]);
});

test("second consecutive 404 deactivates the product", async () => {
  const repository = fakeRepository(
    candidate({
      last_inventory_checked_at: "2026-08-10T08:00:00.000Z",
      inventory_check_failures: 1,
    }),
  );
  const result = await recheck(env(), {
    now: NOW,
    repository,
    fetchFn: async () => upstreamResponse("<html>not found</html>", 404),
  });

  assert.equal(result.outcome, "missing_deactivated");
  assert.equal(result.failureCount, 2);
  assert.deepEqual(repository.calls.at(-1), ["unavailable", 7, NOW.toISOString(), 2, true]);
});

test("a later listing observation resets the effective unavailable streak", async () => {
  const repository = fakeRepository(
    candidate({
      last_seen_at: "2026-08-10T09:00:00.000Z",
      last_inventory_checked_at: "2026-08-09T08:00:00.000Z",
      inventory_check_failures: 1,
    }),
  );
  const result = await recheck(env(), {
    now: NOW,
    repository,
    fetchFn: async () => upstreamResponse("<html>not found</html>", 404),
  });

  assert.equal(result.outcome, "missing_retry");
  assert.equal(result.failureCount, 1);
  assert.deepEqual(repository.calls.at(-1), ["unavailable", 7, NOW.toISOString(), 1, false]);
});

test("429 is deferred after recording only the attempt timestamp", async () => {
  const repository = fakeRepository();
  const result = await recheck(env(), {
    now: NOW,
    repository,
    fetchFn: async () => upstreamResponse("rate limited", 429, "text/plain"),
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.reason, "upstream_http_429");
  assert.equal(repository.calls.length, 2);
  assert.equal(repository.calls[1][0], "attempt");
});

test("robots rejection is deferred without changing inventory state", async () => {
  const repository = fakeRepository();
  const result = await recheck(env(), {
    now: NOW,
    repository,
    fetchFn: async () =>
      new Response('{"error":"robots_disallowed"}', {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.reason, "robots_disallowed");
  assert.equal(repository.calls.length, 2);
  assert.equal(repository.calls[1][0], "attempt");
});

test("ambiguous 200 response never deactivates and resets unavailable evidence", async () => {
  const repository = fakeRepository(candidate({ inventory_check_failures: 1 }));
  const result = await recheck(env(), {
    now: NOW,
    repository,
    fetchFn: async () => upstreamResponse("<html><body>商品情報のみ</body></html>"),
  });

  assert.equal(result.outcome, "ambiguous");
  assert.deepEqual(repository.calls.at(-1), ["ambiguous", 7, NOW.toISOString()]);
});

test("disabled rechecks do not select or fetch a product", async () => {
  const repository = fakeRepository();
  let fetched = false;
  const result = await recheck(env({ AUDIOUNION_INVENTORY_RECHECK_ENABLED: "false" }), {
    now: NOW,
    repository,
    fetchFn: async () => {
      fetched = true;
      throw new Error("must not fetch");
    },
  });

  assert.deepEqual(result, { status: "skipped", reason: "disabled" });
  assert.equal(repository.calls.length, 0);
  assert.equal(fetched, false);
});
