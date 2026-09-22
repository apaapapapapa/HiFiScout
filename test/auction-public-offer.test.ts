import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { auctionSnapshot } from "./helpers/auction-snapshot.js";
import { toAuctionOffer } from "../src/auctions/public-offer.js";
import { applyAuctionObservation, emptyAuctionLiveFacts } from "../src/auctions/observations.js";

const identity = {
  catalogProductId: null,
  manufacturer: "Example",
  model: "A-100 MK II",
  categoryId: "AMP.INTEGRATED",
};
const now = "2026-09-22T01:01:00.000Z";

test("public auction serialization excludes raw evidence and extra nested runtime fields", () => {
  const base = auctionSnapshot();
  const current = base.live.currentPrice;
  assert.ok(current);
  const snapshot = {
    ...base,
    item: {
      ...base.item,
      title: "private-evidence-title",
      rawManufacturer: "private-evidence-manufacturer",
      rawModel: "private-evidence-model",
      conditionText: "private-evidence-condition",
    },
    live: {
      ...base.live,
      currentPrice: {
        ...current,
        value: { ...current.value, rawPrice: "private-evidence-price" },
        internal: "private-evidence-price-fact",
      },
      bidCount: { value: 0, observedAt: base.stamp.observedAt, rawBids: "private-evidence-bids" },
    },
    futureInternalField: "private-evidence-new-field",
  };
  const mappedIdentity = { ...identity, internal: "private-evidence-identity" };
  const offer = toAuctionOffer(snapshot, mappedIdentity, now);
  assert.equal(JSON.stringify(offer).includes("private-evidence"), false);
  for (const key of [
    "item",
    "live",
    "stamp",
    "cycle",
    "title",
    "rawManufacturer",
    "rawModel",
    "sourceCategoryId",
    "sourceCategoryPath",
    "conditionText",
    "futureInternalField",
    "internal",
  ]) {
    assert.equal(Object.hasOwn(offer, key), false, key);
  }
  assert.equal(offer.manufacturer, identity.manufacturer);
  assert.equal(offer.model, identity.model);
  assert.equal(offer.currentPrice?.amountYen, 88_000);
  assert.equal(offer.currentPrice?.tax, "inclusive");
  assert.equal(offer.bidCount?.value, 0);
  assert.equal(offer.currentPrice?.observedAt, base.live.currentPrice?.observedAt);
  assert.equal(offer.displayState, "open");
});

test("public buy-now prices distinguish a known price, explicit none and unobserved availability", () => {
  const first = auctionSnapshot();
  const known = toAuctionOffer(first, identity, now);
  assert.deepEqual(known.buyNowPrice, {
    status: "set",
    price: { amountYen: 120_000, tax: "inclusive", observedAt: first.stamp.observedAt },
  });
  const absent = toAuctionOffer(auctionSnapshot(1), identity, now);
  assert.deepEqual(absent.buyNowPrice, { status: "none", observedAt: first.stamp.observedAt });
  const unknown = toAuctionOffer(
    {
      ...first,
      live: { ...first.live, currentPrice: null, buyNowPrice: null },
    },
    identity,
    now,
  );
  assert.deepEqual(unknown.buyNowPrice, { status: "unknown" });
  assert.equal(unknown.currentPrice, null);
  const zero = toAuctionOffer(
    {
      ...first,
      live: {
        ...first.live,
        buyNowPrice: {
          value: { amountYen: 0, tax: "unknown" },
          observedAt: first.stamp.observedAt,
        },
      },
    },
    identity,
    now,
  );
  assert.deepEqual(zero.buyNowPrice, {
    status: "set",
    price: { amountYen: 0, tax: "unknown", observedAt: first.stamp.observedAt },
  });
});

test("public partial rechecks preserve independent price times and source-state freshness", () => {
  const first = auctionSnapshot();
  const at = "2026-09-22T02:00:00.000Z";
  const result = applyAuctionObservation(first, {
    ...first,
    stamp: { generation: 1, sequence: 2, observedAt: at },
    live: { ...emptyAuctionLiveFacts(), buyNowPrice: { value: null, observedAt: at } },
  });
  assert.ok(result.snapshot);
  const offer = toAuctionOffer(result.snapshot, identity, at, 60_000);
  assert.equal(offer.currentPrice?.observedAt, first.stamp.observedAt);
  assert.deepEqual(offer.buyNowPrice, { status: "none", observedAt: at });
  assert.equal(offer.freshness, "stale");
});

test("public reads derive expiry without changing saved facts or refreshing their timestamps", () => {
  const snapshot = auctionSnapshot();
  const before = JSON.stringify(snapshot);
  assert.equal(toAuctionOffer(snapshot, identity, "invalid").displayState, "unknown");
  assert.equal(
    toAuctionOffer(snapshot, identity, "2026-09-22T12:31:00Z").displayState,
    "end_check_pending",
  );
  assert.equal(JSON.stringify(snapshot), before);
});
