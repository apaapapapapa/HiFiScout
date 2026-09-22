import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  applyAuctionObservation,
  auctionPresentation,
  emptyAuctionLiveFacts,
} from "../src/auctions/observations.js";
import { yahooAuctionSaleSubject } from "../src/auctions/yahoo/values.js";
import type { AuctionObservation } from "../src/auctions/types.js";

test("seller subject labels cannot resolve Object prototype properties", () => {
  for (const value of ["constructor", "toString", "__proto__", "hasOwnProperty", "不明"]) {
    assert.equal(yahooAuctionSaleSubject(value), "unknown");
  }
  assert.equal(yahooAuctionSaleSubject("空箱のみ"), "empty_box");
});

test("explicit terminal rechecks refresh evidence, unknown rechecks do not", () => {
  const firstTime = "2026-09-22T01:00:00.000Z";
  const nextTime = "2026-09-22T02:00:00.000Z";
  const first: AuctionObservation = {
    source: "yahoo-auctions",
    auctionId: "a1234567890",
    sourceUrl: "https://auctions.yahoo.co.jp/jp/auction/a1234567890",
    stamp: { generation: 1, sequence: 1, observedAt: firstTime },
    item: {
      title: "EXAMPLE A-100",
      rawManufacturer: null,
      rawModel: null,
      sourceCategoryId: "2084037425",
      sourceCategoryPath: ["23764", "23792", "2084037425"],
      rawCategory: "一般",
      categoryHint: "",
      conditionText: null,
      saleUnit: "unknown",
      saleSubject: "unknown",
    },
    live: {
      ...emptyAuctionLiveFacts(),
      sourceState: { value: "ended", observedAt: firstTime },
    },
  };
  const initial = applyAuctionObservation(null, first);
  assert.ok(initial.snapshot);
  const next: AuctionObservation = {
    ...first,
    stamp: { generation: 1, sequence: 2, observedAt: nextTime },
    live: {
      ...emptyAuctionLiveFacts(),
      sourceState: { value: "ended", observedAt: nextTime },
    },
  };
  const refreshed = applyAuctionObservation(initial.snapshot, next);
  assert.equal(refreshed.status, "applied");
  assert.ok(refreshed.snapshot);
  assert.equal(refreshed.snapshot.live.sourceState?.observedAt, nextTime);
  const view = auctionPresentation(refreshed.snapshot, nextTime, 60_000);
  assert.equal(view.freshness, "fresh");
  assert.equal(view.phase, "ended");
  next.live.sourceState = { value: "unknown", observedAt: nextTime };
  const unresolved = applyAuctionObservation(initial.snapshot, next);
  assert.equal(unresolved.snapshot?.live.sourceState?.observedAt, firstTime);
  assert.equal(unresolved.snapshot?.live.sourceState?.value, "ended");
});
