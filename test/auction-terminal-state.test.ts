import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { auctionFixture } from "./helpers/auction-fixture.js";
import {
  acceptsAuctionObservation,
  auctionDisplayState,
  parseAuctionObservation,
} from "../src/auctions/observation.js";

test("unknown or unavailable observations cannot erase a confirmed ending", () => {
  const ended = auctionFixture({ sourceStatus: "ended" });
  for (const sourceStatus of ["unknown", "unavailable", "active"] as const) {
    const next = auctionFixture({
      sourceStatus,
      requestedAt: "2026-09-19T11:00:00.000Z",
      observedAt: "2026-09-19T11:00:01.000Z",
    });
    assert.equal(acceptsAuctionObservation(ended, next), false, sourceStatus);
  }
  const stillEnded = auctionFixture({
    sourceStatus: "ended",
    requestedAt: "2026-09-19T11:00:00.000Z",
    observedAt: "2026-09-19T11:00:01.000Z",
  });
  assert.equal(acceptsAuctionObservation(ended, stillEnded), true);
});

test("future starts and end-before-start timestamps fail observation validation", () => {
  assert.equal(
    parseAuctionObservation(auctionFixture({ sourceStartedAt: "2026-09-20T00:00:00.000Z" })),
    null,
  );
  assert.equal(
    parseAuctionObservation(auctionFixture({ scheduledEndAt: "2026-09-17T00:00:00.000Z" })),
    null,
  );
  assert.notEqual(parseAuctionObservation(auctionFixture({ sourceStartedAt: null })), null);
});

test("every source status stays unknown until its observation clock is valid", () => {
  for (const sourceStatus of ["active", "ended", "unavailable", "unknown"] as const) {
    const item = parseAuctionObservation(auctionFixture({ sourceStatus }));
    assert.ok(item);
    const observedAt = Date.parse(item.observedAt);
    for (const now of [NaN, Infinity, -Infinity, observedAt - 1]) {
      assert.equal(auctionDisplayState(item, now), "unknown", `${sourceStatus}: ${now}`);
    }
    assert.equal(auctionDisplayState(item, observedAt), sourceStatus);
    assert.equal(auctionDisplayState({ ...item, observedAt: "invalid" }, observedAt), "unknown");
  }
});
