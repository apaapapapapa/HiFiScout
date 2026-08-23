import test from "node:test";
import assert from "node:assert/strict";

import {
  matchesDispatchReservation,
  readCrawlLifecycle,
  retryAfterExecutionLeaseSeconds,
  shouldRecoverDispatch,
  type CrawlLifecycleRow,
} from "../src/crawler/crawl-lifecycle.js";
import { crawlDispatchToken } from "../src/db/shop-state-repository.js";
import { shopSyncStateRow } from "./helpers/fixtures.js";

function lifecycleRow(
  overrides: Partial<CrawlLifecycleRow> & Pick<CrawlLifecycleRow, "shop_key">,
): CrawlLifecycleRow {
  return {
    ...shopSyncStateRow({ shop_key: overrides.shop_key }),
    queued_token: null,
    queued_last_sent_at: null,
    crawl_lease_token: null,
    crawl_lease_until: null,
    ...overrides,
  };
}

test("crawl lifecycle makes idle, queued, and executing states explicit", () => {
  const now = new Date("2026-08-23T01:00:00.000Z");
  const requestedAt = "2026-08-23T00:00:00.000Z";
  const dispatchToken = crawlDispatchToken("home-shokai", requestedAt);

  assert.equal(readCrawlLifecycle(lifecycleRow({ shop_key: "home-shokai" }), now).phase, "idle");

  const queued = readCrawlLifecycle(
    lifecycleRow({
      shop_key: "home-shokai",
      queued_at: requestedAt,
      queued_token: dispatchToken,
      queued_last_sent_at: requestedAt,
    }),
    now,
  );
  assert.equal(queued.phase, "queued");
  assert.equal(queued.dispatchToken, dispatchToken);

  const executing = readCrawlLifecycle(
    lifecycleRow({
      shop_key: "home-shokai",
      queued_at: requestedAt,
      queued_token: dispatchToken,
      queued_last_sent_at: requestedAt,
      crawl_lease_token: `${dispatchToken}:lease`,
      crawl_lease_until: "2026-08-23T01:10:00.000Z",
    }),
    now,
  );
  assert.equal(executing.phase, "executing");
});

test("an expired execution lease returns the same logical child to queued state", () => {
  const requestedAt = "2026-08-23T00:00:00.000Z";
  const state = lifecycleRow({
    shop_key: "home-shokai",
    queued_at: requestedAt,
    queued_token: crawlDispatchToken("home-shokai", requestedAt),
    queued_last_sent_at: requestedAt,
    crawl_lease_token: "expired-lease",
    crawl_lease_until: "2026-08-23T00:20:00.000Z",
  });

  const lifecycle = readCrawlLifecycle(state, new Date("2026-08-23T01:00:00.000Z"));
  assert.equal(lifecycle.phase, "queued");
  assert.equal(shouldRecoverDispatch(state, new Date("2026-08-23T01:00:00.000Z"), 30), true);
});

test("a live execution lease suppresses watchdog recovery and returns a bounded retry delay", () => {
  const requestedAt = "2026-08-23T00:00:00.000Z";
  const state = lifecycleRow({
    shop_key: "home-shokai",
    queued_at: requestedAt,
    queued_token: crawlDispatchToken("home-shokai", requestedAt),
    queued_last_sent_at: requestedAt,
    crawl_lease_token: "live-lease",
    crawl_lease_until: "2026-08-23T01:10:00.000Z",
  });
  const now = new Date("2026-08-23T01:00:00.000Z");

  assert.equal(shouldRecoverDispatch(state, now, 30), false);
  assert.equal(retryAfterExecutionLeaseSeconds(state, now, 5), 605);
  assert.equal(matchesDispatchReservation(state, "home-shokai", requestedAt), true);
});

test("invalid lease column combinations are surfaced instead of inferred", () => {
  const lifecycle = readCrawlLifecycle(
    lifecycleRow({
      shop_key: "home-shokai",
      queued_at: "2026-08-23T00:00:00.000Z",
      crawl_lease_token: "partial-lease",
      crawl_lease_until: null,
    }),
    new Date("2026-08-23T01:00:00.000Z"),
  );

  assert.equal(lifecycle.phase, "invalid");
  assert.equal(lifecycle.invalidReason, "partial_execution_lease");
});
