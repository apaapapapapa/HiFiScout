import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  hasDispatchReservation,
  readCrawlLifecycle,
  shouldRecoverDispatch,
  type CrawlDispatchStateRow,
} from "../src/crawler/crawl-lifecycle.js";
import { crawlDispatchToken } from "../src/db/shop-state-repository.js";
import { shopSyncStateRow } from "./helpers/fixtures.js";

function lifecycleRow(
  overrides: Partial<CrawlDispatchStateRow> & Pick<CrawlDispatchStateRow, "shop_key">,
): CrawlDispatchStateRow {
  return {
    ...shopSyncStateRow({ shop_key: overrides.shop_key }),
    dispatch_requested_at: null,
    dispatch_token: null,
    dispatch_last_sent_at: null,
    ...overrides,
  };
}

test("crawl lifecycle makes idle and dispatched states explicit", () => {
  const requestedAt = "2026-08-23T00:00:00.000Z";
  const dispatchToken = crawlDispatchToken("home-shokai", requestedAt);

  assert.equal(readCrawlLifecycle(lifecycleRow({ shop_key: "home-shokai" })).phase, "idle");

  const dispatched = readCrawlLifecycle(
    lifecycleRow({
      shop_key: "home-shokai",
      dispatch_requested_at: requestedAt,
      dispatch_token: dispatchToken,
      dispatch_last_sent_at: requestedAt,
    }),
  );
  assert.equal(dispatched.phase, "dispatched");
  assert.equal(dispatched.dispatchToken, dispatchToken);
  assert.equal(dispatched.lastSentAt, requestedAt);
  assert.equal(
    hasDispatchReservation(
      lifecycleRow({
        shop_key: "home-shokai",
        dispatch_requested_at: requestedAt,
        dispatch_token: dispatchToken,
      }),
    ),
    true,
  );
});

test("a dispatched generation becomes recoverable only after its quiet window", () => {
  const requestedAt = "2026-08-23T00:00:00.000Z";
  const state = lifecycleRow({
    shop_key: "home-shokai",
    dispatch_requested_at: requestedAt,
    dispatch_token: crawlDispatchToken("home-shokai", requestedAt),
    dispatch_last_sent_at: requestedAt,
  });

  assert.equal(shouldRecoverDispatch(state, new Date("2026-08-23T00:29:59.000Z"), 30), false);
  assert.equal(shouldRecoverDispatch(state, new Date("2026-08-23T00:30:00.000Z"), 30), true);
});

test("missing or malformed dispatch identity is surfaced instead of inferred", () => {
  const requestedAt = "2026-08-23T00:00:00.000Z";

  const missingToken = readCrawlLifecycle(
    lifecycleRow({
      shop_key: "home-shokai",
      dispatch_requested_at: requestedAt,
      dispatch_token: null,
    }),
  );
  assert.equal(missingToken.phase, "invalid");
  assert.equal(missingToken.invalidReason, "partial_dispatch");

  const orphanedToken = readCrawlLifecycle(
    lifecycleRow({
      shop_key: "home-shokai",
      dispatch_requested_at: null,
      dispatch_token: "orphaned-token",
    }),
  );
  assert.equal(orphanedToken.phase, "invalid");
  assert.equal(orphanedToken.invalidReason, "partial_dispatch");

  const invalidRequestedAt = readCrawlLifecycle(
    lifecycleRow({
      shop_key: "home-shokai",
      dispatch_requested_at: "not-a-date",
      dispatch_token: "home-shokai:not-a-date",
    }),
  );
  assert.equal(invalidRequestedAt.phase, "invalid");
  assert.equal(invalidRequestedAt.invalidReason, "invalid_requested_at");
});
