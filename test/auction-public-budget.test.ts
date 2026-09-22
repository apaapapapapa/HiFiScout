import { it, expect } from "vite-plus/test";
import {
  initialAuctionRuntime,
  emptyAuctionCharge,
  reserveAuctionBudget,
} from "../src/auctions/runtime-policy.js";
it("mixed public load exhausts ordinary reads while preserving bounded confirmation and stopping", () => {
  const now = Date.parse("2026-09-22T01:00:00Z");
  let state = initialAuctionRuntime(now);
  const publicRead = {
    ...emptyAuctionCharge(),
    requests: 1,
    publicRequests: 1,
    reads: 15100,
    writes: 20,
    durationGbSeconds: 0.25,
  };
  for (let i = 0; i < 13; i++) state = reserveAuctionBudget(state, publicRead, now)!;
  expect(state.reserved.publicRequests).toBe(13);
  expect(reserveAuctionBudget(state, publicRead, now)).toBeNull();
  const recovery = reserveAuctionBudget(
    state,
    {
      ...emptyAuctionCharge(),
      requests: 1,
      sellerRequests: 1,
      reads: 5000,
      writes: 2000,
      durationGbSeconds: 4,
    },
    now,
    true,
  )!;
  expect(recovery.reserved.reads).toBe(201300);
  const stopped = reserveAuctionBudget(
    recovery,
    { ...emptyAuctionCharge(), requests: 1, reads: 100, writes: 50, durationGbSeconds: 0.25 },
    now,
    true,
  )!;
  expect(stopped.reserved.publicRequests).toBe(13);
  expect(stopped.reserved.reads).toBe(201400);
  expect(reserveAuctionBudget(stopped, publicRead, now)).toBeNull();
});
it("legacy persisted budgets start the new public dimension at zero without resetting other charges", () => {
  const now = Date.parse("2026-09-22T01:00:00Z");
  const state = initialAuctionRuntime(now);
  state.reserved.reads = 12345;
  delete (state.reserved as Partial<typeof state.reserved>).publicRequests;
  const next = reserveAuctionBudget(state, { ...emptyAuctionCharge(), publicRequests: 1 }, now)!;
  expect(next.reserved.publicRequests).toBe(1);
  expect(next.reserved.reads).toBe(12345);
});
