import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { auctionSnapshot } from "./helpers/auction-snapshot.js";
import { auctionPresentation } from "../src/auctions/observations.js";

test("all auction phases remain unknown for invalid clocks or future observation evidence", () => {
  for (const value of ["open", "ended", "unavailable", "unknown"] as const) {
    const snapshot = auctionSnapshot();
    const at = snapshot.stamp.observedAt;
    snapshot.live.sourceState = { value, observedAt: at };
    for (const now of ["invalid", "NaN", "Infinity", "", "2026-09-22T00:59:59.999Z"]) {
      const view = auctionPresentation(snapshot, now, 60_000);
      assert.equal(view.phase, "unknown", `${value}: ${now}`);
      assert.equal(view.freshness, "unknown");
    }
    const exact = auctionPresentation(snapshot, at, 60_000);
    assert.equal(exact.phase, value);
    assert.equal(exact.freshness, "fresh");
    for (const observedAt of ["invalid", "2026-09-22T01:00:00.001Z"]) {
      snapshot.live.sourceState = { value, observedAt };
      const view = auctionPresentation(snapshot, at, 60_000);
      assert.equal(view.phase, "unknown");
      assert.equal(view.freshness, "unknown");
    }
  }
});

test("an invalid snapshot timestamp cannot certify an otherwise known terminal state", () => {
  const snapshot = auctionSnapshot(1);
  snapshot.stamp.observedAt = "invalid";
  const view = auctionPresentation(snapshot, "2026-09-22T01:01:00Z", 60_000);
  assert.equal(view.phase, "unknown");
  assert.equal(view.freshness, "unknown");
  assert.equal(snapshot.live.sourceState?.value, "ended");
});
