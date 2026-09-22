import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  auctionComparablePriceYen,
  auctionPriceMatchesRange,
  compareAuctionPrices,
} from "../src/auctions/prices.js";
import type { AuctionPrice } from "../src/auctions/types.js";

const inclusive: AuctionPrice = { amountYen: 100, tax: "inclusive" };
const exempt: AuctionPrice = { amountYen: 200, tax: "exempt" };
const exclusive: AuctionPrice = { amountYen: 90, tax: "exclusive" };
const unknown: AuctionPrice = { amountYen: 1, tax: "unknown" };

test("only explicit gross or tax-exempt auction amounts authorize comparison", () => {
  assert.equal(auctionComparablePriceYen(inclusive), 100);
  assert.equal(auctionComparablePriceYen(exempt), 200);
  for (const price of [exclusive, unknown, null, undefined]) {
    assert.equal(auctionComparablePriceYen(price), null);
  }
  assert.deepEqual(exclusive, { amountYen: 90, tax: "exclusive" });
  assert.deepEqual(unknown, { amountYen: 1, tax: "unknown" });
});

test("unknown auction prices stay last in both ascending and descending order", () => {
  const prices = [unknown, exempt, exclusive, inclusive, null];
  const ascending = [...prices].sort((left, right) => compareAuctionPrices(left, right, "asc"));
  const descending = [...prices].sort((left, right) => compareAuctionPrices(left, right, "desc"));
  assert.deepEqual(ascending, [inclusive, exempt, unknown, exclusive, null]);
  assert.deepEqual(descending, [exempt, inclusive, unknown, exclusive, null]);
  assert.equal(compareAuctionPrices(null, unknown, "asc"), 0);
  assert.equal(compareAuctionPrices(null, unknown, "desc"), 0);
});

test("only an active price range excludes unknown auction prices", () => {
  for (const price of [unknown, exclusive, null, undefined]) {
    assert.equal(auctionPriceMatchesRange(price, null, null), true);
    assert.equal(auctionPriceMatchesRange(price, 0, null), false);
    assert.equal(auctionPriceMatchesRange(price, null, 1000), false);
  }
  assert.equal(auctionPriceMatchesRange(inclusive, 100, 100), true);
  assert.equal(auctionPriceMatchesRange(inclusive, 101, null), false);
  assert.equal(auctionPriceMatchesRange(exempt, null, 199), false);
});

test("current and instant-buy observations use the same independent price rules", () => {
  const currentPrice = { value: exclusive, observedAt: "2026-09-22T01:00:00.000Z" };
  const buyNowPrice = { value: inclusive, observedAt: "2026-09-22T01:00:00.000Z" };
  assert.equal(auctionComparablePriceYen(currentPrice.value), null);
  assert.equal(auctionComparablePriceYen(buyNowPrice.value), 100);
  assert.equal(auctionPriceMatchesRange(currentPrice.value, null, 100), false);
  assert.equal(auctionPriceMatchesRange(buyNowPrice.value, null, 100), true);
});

test("zero remains a known price while malformed amounts and ranges are rejected", () => {
  const zero: AuctionPrice = { amountYen: 0, tax: "inclusive" };
  assert.equal(auctionComparablePriceYen(zero), 0);
  assert.equal(auctionPriceMatchesRange(zero, 0, 0), true);
  for (const amountYen of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(auctionComparablePriceYen({ amountYen, tax: "inclusive" }), null);
    assert.throws(() => auctionPriceMatchesRange(inclusive, amountYen, null));
  }
  assert.throws(() => auctionPriceMatchesRange(inclusive, 2, 1));
});
