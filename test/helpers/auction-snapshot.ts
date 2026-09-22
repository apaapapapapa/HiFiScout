import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyAuctionObservation } from "../../src/auctions/observations.js";
import type { AuctionSnapshot } from "../../src/auctions/types.js";
import { parseYahooAuctionHtml } from "../../src/auctions/yahoo/parser.js";

const fixture = readFileSync(
  new URL("../fixtures/yahoo-auctions.synthetic.html", import.meta.url),
  "utf8",
);

/** Exercise the canonical parser/reducer with the existing synthetic source fixture. */
export function auctionSnapshot(index = 0): AuctionSnapshot {
  const parsed = parseYahooAuctionHtml(fixture, {
    generation: 1,
    sequence: 1,
    observedAt: "2026-09-22T01:00:00Z",
    categoryId: "2084037425",
  });
  assert.equal(parsed.status, "parsed");
  const observation = parsed.observations[index];
  assert.ok(observation);
  const result = applyAuctionObservation(null, observation);
  assert.equal(result.status, "applied");
  assert.ok(result.snapshot);
  return result.snapshot;
}
