import { it, expect, vi } from "vite-plus/test";
import { AuctionScheduler } from "../src/auctions/scheduler.js";
import { initialAuctionRuntime, auctionRetryAt } from "../src/auctions/runtime-policy.js";
import type { AuctionStore } from "../src/auctions/storage.js";
import { yahooAuctionHtmlSource } from "../src/auctions/yahoo/parser.js";
import type { AuctionTask } from "../src/auctions/runtime-policy.js";
import type { AuctionAcquisition } from "../src/auctions/yahoo/acquisition.js";
import { auctionRobotsPermit } from "../src/auctions/yahoo/acquisition.js";

it("unsupported robots pacing halts instead of creating an unbounded dormant task", () => {
  const url = "https://auctions.yahoo.co.jp/jp/auction/a100001";
  const permit = (seconds: string) =>
    auctionRobotsPermit(`User-agent: *\nAllow: /\nCrawl-delay: ${seconds}`, url);
  expect(permit("120")).toEqual({ allowed: true, delayMs: 120_000 });
  expect(permit("2592000")).toEqual({ allowed: true, delayMs: 30 * 86_400_000 });
  expect(permit("2678401").allowed).toBe(false);
  expect(permit("1000000000000000000").allowed).toBe(false);
});

it("an overflowing numeric Retry-After remains a finite unsupported delay for the halt policy", () => {
  const now = Date.parse("2026-09-22T01:00:00Z");
  const due = auctionRetryAt(1, now, "9".repeat(400));
  expect(Number.isFinite(due)).toBe(true);
  expect(due).toBeGreaterThan(now + 30 * 86_400_000);
  expect(auctionRetryAt(1, now, "120")).toBe(now + 120_000);
});

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
  store.getAlarm = () => store.storage.getAlarm();
  store.setAlarm = (at) => store.storage.setAlarm(at);
  store.deleteAlarm = () => store.storage.deleteAlarm();
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

it.each(["wake", "public_pause", "public_resume"] as const)(
  "%s fences an in-flight response when the category scope is removed",
  async (action) => {
    const now = Date.parse("2026-09-22T01:00:00Z");
    let state = { ...initialAuctionRuntime(now), paused: false, categories: ["2084037425"] };
    state.robots = { text: "User-agent: *\nAllow: /", observedAt: now, delayMs: 60_000 };
    let task: AuctionTask = {
      id: "discover:2084037425",
      kind: "discover",
      categoryId: "2084037425",
      auctionId: null,
      page: 1,
      due: now,
      attempts: 0,
      sequence: null,
    };
    let alarm: number | null = null;
    const store = {
      runtime: () => structuredClone(state),
      saveRuntime: (value: typeof state) => {
        state = value;
      },
      getTask: () => task,
      nextTask: () => task,
      task: (value: AuctionTask) => {
        task = value;
      },
      retain: () => {},
      storage: {
        transactionSync: (fn: () => void) => fn(),
        getAlarm: async () => alarm,
        setAlarm: async (value: number) => {
          alarm = value;
        },
        deleteAlarm: async () => {
          alarm = null;
        },
      },
    } as unknown as AuctionStore;
    store.getAlarm = () => store.storage.getAlarm();
    store.setAlarm = (at) => store.storage.setAlarm(at);
    store.deleteAlarm = () => store.storage.deleteAlarm();
    let complete!: (response: AuctionAcquisition) => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<AuctionAcquisition>((resolve) => {
      complete = resolve;
    });
    const parse = vi.fn(yahooAuctionHtmlSource.parse);
    const scheduler = new AuctionScheduler(
      store,
      {
        request: async () => {
          started();
          return response;
        },
      },
      { ...yahooAuctionHtmlSource, parse },
      () => true,
      () => now,
    );
    const pending = scheduler.alarm();
    await start;
    const issuedGeneration = state.generation;
    await scheduler.control(action, []);
    expect(state.generation).toBe(issuedGeneration + 1);
    complete({
      status: 200,
      text: "<li class=Product>delayed</li>",
      retryAfter: null,
      authenticationRequired: false,
    });
    await pending;
    expect(parse).not.toHaveBeenCalled();
    expect(state.categories).toEqual([]);
    expect(state.reserved.sellerRequests).toBe(1);
    expect(state.lastSuccessAt).toBeNull();
  },
);

it("reviewed halt clearing preserves pause, pacing and charged budgets and fences delayed work", async () => {
  const now = Date.parse("2026-09-22T01:00:00Z");
  let state = { ...initialAuctionRuntime(now), halt: "source_contract", throttleCount: 3 };
  state.reserved.reads = 150_000;
  state.backoffUntil = now + 3_600_000;
  state.nextFetchAt = now + 60_000;
  const store = {
    runtime: () => structuredClone(state),
    saveRuntime: (value: typeof state) => {
      state = value;
    },
    storage: { transactionSync: (fn: () => void) => fn() },
    deleteAlarm: vi.fn(async () => {}),
  } as unknown as AuctionStore;
  const request = vi.fn(async () => {
    throw new Error("must_not_fetch");
  });
  let allowed = false;
  const scheduler = new AuctionScheduler(
    store,
    { request },
    yahooAuctionHtmlSource,
    () => allowed,
    () => now,
  );
  await expect(scheduler.control("clear_halt")).rejects.toThrow("auction_halt_review_required");
  allowed = true;
  state.paused = false;
  await expect(scheduler.control("clear_halt")).rejects.toThrow("auction_halt_review_required");
  state.paused = true;
  const before = structuredClone(state);
  await scheduler.control("clear_halt");
  expect(state).toEqual({
    ...before,
    halt: null,
    throttleCount: 0,
    generation: before.generation + 1,
  });
  expect(store.deleteAlarm).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
});
