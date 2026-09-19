import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import type { AuctionObservation } from "../src/api/auction-contracts.js";
import {
  acceptsAuctionObservation,
  auctionDisplayState,
  canonicalAuctionUrl,
  parseAuctionObservation,
} from "../src/auctions/observation.js";
import { auctionConfiguration } from "../src/auctions/config.js";

function observation(changes: Partial<AuctionObservation> = {}): AuctionObservation {
  return {
    source: "yahoo-auctions",
    auctionId: "a1234567890",
    sourceUrl: "https://auctions.yahoo.co.jp/jp/auction/a1234567890",
    title: "Example Model II ペア",
    rawManufacturer: "Example",
    rawModel: "Model II",
    sourceCategoryId: "23764",
    rawCategoryPath: "オーディオ機器",
    condition: "unknown",
    saleSubject: "unknown",
    saleUnit: "pair",
    currentPriceYen: 1,
    buyNowPriceYen: null,
    bidCount: 0,
    taxStatus: "unknown",
    shipping: "unknown",
    sourceStatus: "active",
    sourceStartedAt: "2026-09-18T00:00:00.000Z",
    scheduledEndAt: "2026-09-19T12:00:00.000Z",
    requestedAt: "2026-09-19T10:00:00.000Z",
    observedAt: "2026-09-19T10:00:01.000Z",
    ...changes,
  };
}

test("auction facts keep starting bids, unknown buy-now/fees and zero bids distinct", () => {
  assert.deepEqual(parseAuctionObservation(observation()), observation());
  assert.equal(parseAuctionObservation(observation({ bidCount: null }))?.bidCount, null);
  assert.equal(parseAuctionObservation(observation({ currentPriceYen: null }))?.currentPriceYen, null);
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
  assert.equal(parseAuctionObservation(observation({ observedAt: "2026-09-18T00:00:00.000Z" })), null);
  assert.equal(parseAuctionObservation(observation({ title: " ", sourceCategoryId: "not-a-category" })), null);
});

test("auction detail URLs reject foreign origins, credentials and identifier mismatch", () => {
  const path = "/jp/auction/a1234567890";
  assert.equal(canonicalAuctionUrl(`https://page.auctions.yahoo.co.jp${path}?tracking=1#x`), `https://auctions.yahoo.co.jp${path}`);
  for (const url of [
    `http://auctions.yahoo.co.jp${path}`,
    `https://auctions.yahoo.co.jp.evil.example${path}`,
    `https://user@auctions.yahoo.co.jp${path}`,
    `https://auctions.yahoo.co.jp:444${path}`,
    `https://auctions.yahoo.co.jp${path}/extra`,
    "https://auctions.yahoo.co.jp/jp/auction/%2e%2e",
    "javascript:alert(1)",
  ]) {
    assert.equal(canonicalAuctionUrl(url), null, url);
  }
  assert.equal(parseAuctionObservation({ ...observation(), auctionId: "b1234567890" }), null);
});

test("passing scheduled end never asserts a confirmed ending or completed sale", () => {
  assert.equal(auctionDisplayState(observation(), Date.parse("2026-09-19T11:00:00.000Z")), "active");
  assert.equal(auctionDisplayState(observation(), Date.parse("2026-09-19T12:00:00.000Z")), "end_confirmation_pending");
  assert.equal(auctionDisplayState(observation({ sourceStatus: "ended" }), Date.parse("2026-09-19T12:00:00.000Z")), "ended");
  assert.equal(auctionDisplayState(observation({ scheduledEndAt: null }), Date.parse("2026-09-19T14:00:00.000Z")), "stale");
  assert.equal(auctionDisplayState(observation({ sourceStatus: "unknown" }), Date.parse("2026-09-19T11:00:00.000Z")), "unknown");
});

test("delayed/repeated observations do not roll back state and a newer end extension is accepted", () => {
  const previous = observation();
  assert.equal(acceptsAuctionObservation(previous, previous), false);
  assert.equal(acceptsAuctionObservation(previous, observation({ requestedAt: "2026-09-19T09:00:00.000Z", observedAt: "2026-09-19T11:00:00.000Z" })), false);
  assert.equal(acceptsAuctionObservation(previous, observation({ requestedAt: "2026-09-19T11:00:00.000Z", observedAt: "2026-09-19T11:00:01.000Z", scheduledEndAt: "2026-09-19T13:00:00.000Z" })), true);
  assert.equal(acceptsAuctionObservation(observation({ sourceStatus: "ended" }), observation({ requestedAt: "2026-09-19T11:00:00.000Z", observedAt: "2026-09-19T11:00:01.000Z" })), false);
  assert.equal(acceptsAuctionObservation(observation({ sourceStatus: "ended" }), observation({ sourceStartedAt: "2026-09-19T10:30:00.000Z", requestedAt: "2026-09-19T11:00:00.000Z", observedAt: "2026-09-19T11:00:01.000Z" })), true);
});

test("auction collection is opt-in with independent source-validation and account-budget gates", () => {
  const off = auctionConfiguration({});
  assert.equal(off.collectionEnabled, false);
  assert.equal(off.publicEnabled, false);
  assert.equal(off.searchEnabled, false);
  assert.deepEqual(off.categoryIds, []);
  assert.ok(off.blockers.includes("source_terms_unreviewed"));
  assert.ok(off.blockers.includes("source_fixture_unverified"));
  assert.ok(off.blockers.includes("account_budget_unreviewed"));
  const env = {
    YAHOO_AUCTIONS_ENABLED: "true",
    YAHOO_AUCTIONS_APPROVAL_REFERENCE: "https://github.com/apaapapapapa/HiFiScout/issues/703",
    YAHOO_AUCTIONS_SOURCE_VALIDATED: "true",
    YAHOO_AUCTIONS_BUDGET_REVIEWED: "true",
    YAHOO_AUCTIONS_CATEGORY_IDS: "23764,23764",
  };
  const on = auctionConfiguration(env);
  assert.equal(on.collectionEnabled, true);
  assert.equal(on.publicEnabled, false);
  assert.deepEqual(on.categoryIds, ["23764"]);
  for (const value of ["0", "-1", "100", "1e4", "oops"]) {
    assert.equal(auctionConfiguration({ ...env, YAHOO_AUCTIONS_REQUEST_DELAY_MS: value }).collectionEnabled, false);
  }
  assert.equal(auctionConfiguration({ ...env, YAHOO_AUCTIONS_CATEGORY_IDS: "23764," }).collectionEnabled, false);
  assert.equal(auctionConfiguration({ ...env, YAHOO_AUCTIONS_BUDGET_REVIEWED: "false" }).collectionEnabled, false);
});
