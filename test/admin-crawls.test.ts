import assert from "node:assert/strict";
import { afterEach, test, vi } from "vite-plus/test";
import { CrawlScheduler } from "../src/crawler/crawl-scheduler-do.js";
import { nextAdminCrawlSchedules } from "../src/crawler/admin-crawl.js";
import { shopsInDailyRotation } from "../src/crawler/schedule.js";
import { isCrawlQuietHours } from "../src/crawler/crawl-window.js";
import {
  markShopSuccess,
  reserveShopDispatch,
  setShopAdminPaused,
} from "../src/db/shop-state-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

afterEach(() => vi.restoreAllMocks());

test("manual pause preserves a live dispatch, blocks new generations and resumes with the same cursor", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    const token = await reserveShopDispatch(db, "home-shokai", "2026-09-01T00:00:00Z", 30);
    const stored = {
      message: {
        shopKey: "home-shokai",
        requestedAt: "2026-09-01T00:00:00Z",
        force: true,
        jobId: token,
        continuation: { phase: "fetch", sequence: 12 },
      },
      acceptedAt: "2026-09-01T00:00:00Z",
    };
    const records = new Map<string, unknown>([["phase2_crawl_execution", structuredClone(stored)]]);
    let alarm: number | null = 1;
    const ctx = {
      blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
      storage: {
        get: async (key: string) => records.get(key),
        put: async (key: string, value: unknown) => {
          records.set(key, value);
        },
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => {
          alarm = at;
        },
        deleteAlarm: async () => {
          alarm = null;
        },
      },
    } as unknown as DurableObjectState;
    const scheduler = new CrawlScheduler(ctx, { DB: db } as unknown as Env);
    const request = (action: string) =>
      new Request("https://scheduler/admin/control", {
        method: "POST",
        body: JSON.stringify({ shopKey: "home-shokai", action }),
      });
    assert.equal((await scheduler.fetch(request("pause"))).status, 200);
    assert.equal(alarm, null);
    assert.equal(
      sqlite.prepare("SELECT admin_paused FROM shop_sync_state WHERE shop_key='home-shokai'").get()
        ?.admin_paused,
      1,
    );
    await new CrawlScheduler(ctx, {
      DB: { prepare: () => assert.fail("paused alarm read D1") },
    } as unknown as Env).alarm();
    assert.deepEqual(records.get("phase2_crawl_execution"), stored);
    assert.equal(await reserveShopDispatch(db, "home-shokai", "2026-09-02T00:00:00Z", 30), null);
    assert.equal(
      sqlite
        .prepare("SELECT dispatch_token FROM shop_sync_state WHERE shop_key='home-shokai'")
        .get()?.dispatch_token,
      token,
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-01T15:00:00Z"));
    assert.equal((await scheduler.fetch(request("resume"))).status, 200);
    assert.equal(alarm, Date.parse("2026-09-01T23:00:00Z"));
    assert.deepEqual(records.get("phase2_crawl_execution"), stored);
    assert.equal(
      sqlite.prepare("SELECT admin_paused FROM shop_sync_state WHERE shop_key='home-shokai'").get()
        ?.admin_paused,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test("pause is idempotent and a paused idle shop cannot reserve work", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    await setShopAdminPaused(db, "hifido", true);
    const before = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    await setShopAdminPaused(db, "hifido", true);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, before);
    assert.equal(await reserveShopDispatch(db, "hifido", "2026-09-01T00:00:00Z", 30), null);
    await setShopAdminPaused(db, "hifido", false);
    assert.ok(await reserveShopDispatch(db, "hifido", "2026-09-01T00:00:00Z", 30));
  } finally {
    sqlite.close();
  }
});

test("success count deltas retain the prior successful inventory across repeated finalization", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    await markShopSuccess(db, "hifido", "2026-09-01T00:00:00Z", 100);
    await markShopSuccess(db, "hifido", "2026-09-02T00:00:00Z", 90);
    await markShopSuccess(db, "hifido", "2026-09-02T00:00:00Z", 90);
    assert.equal(
      sqlite
        .prepare("SELECT previous_item_count FROM shop_sync_state WHERE shop_key='hifido'")
        .get()?.previous_item_count,
      100,
    );
  } finally {
    sqlite.close();
  }
});

test("next schedule shows distinct dedicated slots and keeps every shop out of quiet hours", () => {
  const schedules = nextAdminCrawlSchedules(new Date("2026-09-01T14:00:00Z"));
  assert.equal(schedules.get("audiounion"), "2026-09-01T23:01:00.000Z");
  assert.equal(schedules.get("hifido"), "2026-09-01T23:31:00.000Z");
  assert.equal(schedules.get(shopsInDailyRotation()[0].key), "2026-09-02T02:00:00.000Z");
  for (const at of schedules.values()) assert.equal(isCrawlQuietHours(Date.parse(at)), false);
});
