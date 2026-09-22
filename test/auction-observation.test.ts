import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { auctionFixture as observation } from "./helpers/auction-fixture.js";
import {
  acceptsAuctionObservation,
  auctionDisplayState,
  canonicalAuctionUrl,
  parseAuctionObservation,
} from "../src/auctions/observation.js";

test("auction facts keep starting bids, unknown buy-now/fees and zero bids distinct", () => {
  assert.deepEqual(parseAuctionObservation(observation()), observation());
  assert.equal(parseAuctionObservation(observation({ bidCount: null }))?.bidCount, null);
  assert.equal(
    parseAuctionObservation(observation({ currentPriceYen: null }))?.currentPriceYen,
    null,
  );
  assert.equal(parseAuctionObservation({ ...observation(), description: "seller text" }), null);
  assert.equal(parseAuctionObservation({ ...observation(), images: [] }), null);
  assert.equal(parseAuctionObservation({ ...observation(), priceYen: 1 }), null);
});

test("auction validation rejects invalid prices, missing fields, dates and unsupported statuses", () => {
  for (const value of [-1, 1.5, "100", Infinity, NaN, 1e15, undefined]) {
    assert.equal(parseAuctionObservation({ ...observation(), currentPriceYen: value }), null);
  }
  for (const value of ["sold_out", "sold", "", null, undefined]) {
    assert.equal(parseAuctionObservation({ ...observation(), sourceStatus: value }), null);
  }
  for (const value of ["2026-02-30T00:00:00.000Z", "tomorrow", "", undefined]) {
    assert.equal(parseAuctionObservation({ ...observation(), scheduledEndAt: value }), null);
  }
  assert.equal(
    parseAuctionObservation(observation({ observedAt: "2026-09-18T00:00:00.000Z" })),
    null,
  );
  assert.equal(
    parseAuctionObservation(observation({ title: " ", sourceCategoryId: "not-a-category" })),
    null,
  );
});

test("auction detail URLs reject foreign origins, credentials and identifier mismatch", () => {
  const path = "/jp/auction/a1234567890";
  assert.equal(
    canonicalAuctionUrl(`https://auctions.yahoo.co.jp${path}?tracking=1`),
    `https://auctions.yahoo.co.jp${path}`,
  );
  for (const url of [
    `http://auctions.yahoo.co.jp${path}`,
    `https://auctions.yahoo.co.jp.evil.example${path}`,
    `https://user@auctions.yahoo.co.jp${path}`,
    `https://auctions.yahoo.co.jp:444${path}`,
    `https://auctions.yahoo.co.jp${path}/extra`,
    `https://page.auctions.yahoo.co.jp${path}`,
    `https://auctions.yahoo.co.jp${path}#description`,
    "https://auctions.yahoo.co.jp/jp/auction/%2e%2e",
    "javascript:alert(1)",
  ]) {
    assert.equal(canonicalAuctionUrl(url), null, url);
  }
  assert.equal(parseAuctionObservation({ ...observation(), auctionId: "b1234567890" }), null);
});

test("passing scheduled end never asserts a confirmed ending or completed sale", () => {
  assert.equal(
    auctionDisplayState(observation(), Date.parse("2026-09-19T11:00:00.000Z")),
    "active",
  );
  assert.equal(
    auctionDisplayState(observation(), Date.parse("2026-09-19T12:00:00.000Z")),
    "end_confirmation_pending",
  );
  assert.equal(
    auctionDisplayState(
      observation({ sourceStatus: "ended" }),
      Date.parse("2026-09-19T12:00:00.000Z"),
    ),
    "ended",
  );
  assert.equal(
    auctionDisplayState(
      observation({ scheduledEndAt: null }),
      Date.parse("2026-09-19T14:00:00.000Z"),
    ),
    "stale",
  );
  assert.equal(
    auctionDisplayState(
      observation({ sourceStatus: "unknown" }),
      Date.parse("2026-09-19T11:00:00.000Z"),
    ),
    "unknown",
  );
});

test("delayed/repeated observations do not roll back state and a newer end extension is accepted", () => {
  const previous = observation();
  assert.equal(acceptsAuctionObservation(previous, previous), false);
  assert.equal(
    acceptsAuctionObservation(
      previous,
      observation({
        requestedAt: "2026-09-19T09:00:00.000Z",
        observedAt: "2026-09-19T11:00:00.000Z",
      }),
    ),
    false,
  );
  assert.equal(
    acceptsAuctionObservation(
      previous,
      observation({
        requestedAt: "2026-09-19T11:00:00.000Z",
        observedAt: "2026-09-19T11:00:01.000Z",
        scheduledEndAt: "2026-09-19T13:00:00.000Z",
      }),
    ),
    true,
  );
  assert.equal(
    acceptsAuctionObservation(
      observation({ sourceStatus: "ended" }),
      observation({
        requestedAt: "2026-09-19T11:00:00.000Z",
        observedAt: "2026-09-19T11:00:01.000Z",
      }),
    ),
    false,
  );
  assert.equal(
    acceptsAuctionObservation(
      observation({ sourceStatus: "ended" }),
      observation({
        sourceStartedAt: "2026-09-19T10:30:00.000Z",
        requestedAt: "2026-09-19T11:00:00.000Z",
        observedAt: "2026-09-19T11:00:01.000Z",
      }),
    ),
    true,
  );
});

test("buy-now facts distinguish a set price, explicit absence and unconfirmed availability", () => {
  for (const buyNowPriceStatus of ["none", "unknown"] as const) {
    const item = observation({ buyNowPriceStatus, buyNowPriceYen: null });
    assert.deepEqual(parseAuctionObservation(item), item);
    assert.equal(parseAuctionObservation({ ...item, buyNowPriceYen: 100 }), null);
    assert.equal(parseAuctionObservation({ ...item, buyNowPriceYen: 0 }), null);
  }
  for (const buyNowPriceYen of [0, 100, 1_000_000_000_000]) {
    const item = observation({ buyNowPriceStatus: "set", buyNowPriceYen });
    assert.deepEqual(parseAuctionObservation(item), item);
  }
  for (const buyNowPriceYen of [null, undefined, -1, 1.5, "100", NaN, Infinity, 1e15]) {
    assert.equal(
      parseAuctionObservation({ ...observation(), buyNowPriceStatus: "set", buyNowPriceYen }),
      null,
    );
  }
  for (const buyNowPriceStatus of [undefined, null, "", "not_checked", true]) {
    assert.equal(parseAuctionObservation({ ...observation(), buyNowPriceStatus }), null);
  }
});
