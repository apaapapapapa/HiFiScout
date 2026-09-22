import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test, vi } from "vite-plus/test";
import { CrawlScheduler } from "../src/crawler/crawl-scheduler-do.js";
import {
  dispatchForcedCrawl,
  dispatchScheduledCrawl,
  dueDispatchCandidates,
  recoverStalledCrawlDispatches,
} from "../src/crawler/dispatch.js";
import { getShopState, reserveShopDispatch } from "../src/db/shop-state-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as {
  vars: Record<string, string>;
};
const NOW = Date.parse("2026-09-22T02:00:00.000Z");
const REQUESTED_AT = "2026-09-22T00:00:00.000Z";
const STORAGE_KEY = "phase2_crawl_execution"; // Public DO record name. gitleaks:allow

afterEach(() => vi.restoreAllMocks());

test("production e-earphone is excluded from scheduled, forced and due dispatch", async () => {
  const env = {
    ...config.vars,
    DB: { prepare: () => assert.fail("disabled dispatch accessed D1") },
  } as unknown as Env;
  for (const dispatch of [dispatchScheduledCrawl, dispatchForcedCrawl]) {
    assert.deepEqual(await dispatch(env, "e-earphone", { now: new Date(NOW) }), {
      status: "rejected",
      reason: "disabled",
    });
  }
  const candidates = dueDispatchCandidates(env, [], new Date(NOW));
  assert.ok(!candidates.some(({ adapter }) => adapter.key === "e-earphone"));
  assert.ok(candidates.some(({ adapter }) => adapter.key === "home-shokai"));
});

test("recovery leaves an old disabled e-earphone reservation unchanged", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    await reserveShopDispatch(db, "e-earphone", REQUESTED_AT, 120);
    const before = await getShopState(db, "e-earphone");
    assert.ok(before?.dispatch_token);
    const env = {
      ...config.vars,
      DB: db,
      CRAWL_SCHEDULER: { idFromName: () => assert.fail("disabled collector was dispatched") },
    } as unknown as Env;
    assert.deepEqual(
      await recoverStalledCrawlDispatches(env, { now: new Date(NOW), recoveryMinutes: 30 }),
      [],
    );
    assert.deepEqual(await getShopState(db, "e-earphone"), before);
  } finally {
    sqlite.close();
  }
});

test("admin resume cannot restart collection while production e-earphone is disabled", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(() => assert.fail("seller I/O"));
  const { db, sqlite } = migratedSqlite();
  try {
    const jobId = await reserveShopDispatch(db, "e-earphone", REQUESTED_AT, 120);
    assert.ok(jobId);
    const message = { shopKey: "e-earphone", requestedAt: REQUESTED_AT, force: true, jobId };
    const execution = { message, acceptedAt: REQUESTED_AT, nextOriginNotBeforeMs: 0 };
    const records = new Map<string, unknown>([
      [STORAGE_KEY, execution],
      ["admin_paused", true],
    ]);
    let alarm: number | null = null;
    const ctx = {
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
      storage: {
        get: async (key: string) => structuredClone(records.get(key)),
        put: async (key: string, value: unknown) => {
          records.set(key, structuredClone(value));
        },
        getAlarm: async () => alarm,
        setAlarm: async (value: number) => {
          alarm = value;
        },
        deleteAlarm: async () => {
          alarm = null;
        },
        delete: () => assert.fail("execution deleted"),
      },
    } as unknown as DurableObjectState;
    const scheduler = new CrawlScheduler(ctx, { ...config.vars, DB: db } as unknown as Env);
    const response = await scheduler.fetch(
      new Request("https://scheduler/admin/control", {
        method: "POST",
        body: JSON.stringify({ shopKey: "e-earphone", action: "resume" }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(records.get("admin_paused"), false);
    assert.notEqual(alarm, null);
    await scheduler.alarm();
    assert.equal(alarm, null);
    assert.deepEqual(records.get(STORAGE_KEY), execution);
  } finally {
    sqlite.close();
  }
});
