import { it, expect } from "vite-plus/test";
import { AuctionScheduler } from "../src/auctions/scheduler.js";
import { initialAuctionRuntime } from "../src/auctions/runtime-policy.js";
import type { AuctionStore } from "../src/auctions/storage.js";
import { yahooAuctionHtmlSource } from "../src/auctions/yahoo/parser.js";

it("a rejected invocation keeps one durable next-UTC-day wake without resetting consumption", async () => {
  const now = Date.parse("2026-09-22T23:00:00Z");
  const state = { ...initialAuctionRuntime(now), paused: false };
  state.reserved.reads = 200_000;
  let alarm: number | null = null;
  let writes = 0;
  const store = {
    runtime: () => state,
    storage: {
      getAlarm: async () => alarm,
      setAlarm: async (time: number) => {
        alarm = time;
        writes++;
      },
    },
  } as unknown as AuctionStore;
  const scheduler = new AuctionScheduler(
    store,
    {
      request: async () => {
        throw new Error("must_not_fetch");
      },
    },
    yahooAuctionHtmlSource,
    () => true,
    () => now,
  );
  await scheduler.deferForBudget();
  await scheduler.deferForBudget();
  expect(alarm).toBe(Date.parse("2026-09-23T00:00:00Z"));
  expect(writes).toBe(1);
  expect(state.reserved.reads).toBe(200_000);
  state.paused = true;
  await scheduler.deferForBudget();
  expect(writes).toBe(1);
});
