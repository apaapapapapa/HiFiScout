import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { auctionFixture } from "./helpers/auction-fixture.js";
import { toAuctionOffer } from "../src/auctions/public-offer.js";

const identity = {
  catalogProductId: null,
  manufacturer: "Example",
  model: "Model II",
  categoryId: "SPK.BOOKSHELF",
};
const now = Date.parse("2026-09-19T11:00:00.000Z");

test("public auction serialization excludes retained seller evidence and extra runtime fields", () => {
  const item = {
    ...auctionFixture({
      title: "private-evidence-title",
      rawManufacturer: "private-evidence-manufacturer",
      rawModel: "private-evidence-model",
      rawCategoryPath: "private-evidence-category",
    }),
    futureInternalField: "private-evidence-new-field",
  };
  const mappedIdentity = { ...identity, internal: "private-evidence-identity" };
  const offer = toAuctionOffer(item, mappedIdentity, now);
  const json = JSON.stringify(offer);
  assert.equal(json.includes("private-evidence"), false);
  for (const key of [
    "title",
    "rawManufacturer",
    "rawModel",
    "rawCategoryPath",
    "sourceCategoryId",
    "requestedAt",
    "sourceStartedAt",
    "sourceStatus",
    "futureInternalField",
    "internal",
  ]) {
    assert.equal(Object.hasOwn(offer, key), false, key);
  }
  assert.equal(offer.manufacturer, identity.manufacturer);
  assert.equal(offer.model, identity.model);
  assert.equal(offer.currentPriceYen, 1);
  assert.equal(offer.bidCount, 0);
  assert.equal(offer.saleUnit, "pair");
  assert.equal(offer.priceObservedAt, item.observedAt);
  assert.equal(offer.displayState, "active");
});

test("public buy-now facts preserve availability and do not invent a price observation", () => {
  for (const buyNowPriceStatus of ["none", "unknown"] as const) {
    const offer = toAuctionOffer(
      auctionFixture({ currentPriceYen: null, buyNowPriceStatus, buyNowPriceYen: null }),
      identity,
      now,
    );
    assert.equal(offer.buyNowPriceStatus, buyNowPriceStatus);
    assert.equal(offer.buyNowPriceYen, null);
    assert.equal(offer.priceObservedAt, null);
  }
  const item = auctionFixture({
    currentPriceYen: null,
    buyNowPriceStatus: "set",
    buyNowPriceYen: 100,
  });
  const offer = toAuctionOffer(item, identity, now);
  assert.equal(offer.buyNowPriceStatus, "set");
  assert.equal(offer.buyNowPriceYen, 100);
  assert.equal(offer.priceObservedAt, item.observedAt);
});

test("public auction display evaluates time on each read without refreshing saved facts", () => {
  const item = auctionFixture();
  const before = JSON.stringify(item);
  assert.ok(item.scheduledEndAt);
  assert.equal(toAuctionOffer(item, identity, NaN).displayState, "unknown");
  assert.equal(
    toAuctionOffer(item, identity, Date.parse(item.scheduledEndAt)).displayState,
    "end_confirmation_pending",
  );
  assert.equal(JSON.stringify(item), before);
});
