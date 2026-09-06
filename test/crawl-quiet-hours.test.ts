import assert from "node:assert/strict";
import { afterEach, test, vi } from "vite-plus/test";
import { shopEnvVarName } from "../src/config.js";
import { CrawlScheduler } from "../src/crawler/crawl-scheduler-do.js";
import {
  elapsedCrawlActiveMs,
  isCrawlQuietHours,
  nextCrawlAllowedAt,
} from "../src/crawler/crawl-window.js";
import {
  dispatchDueCrawls,
  dispatchForcedCrawl,
  dispatchScheduledCrawl,
  dueDispatchCandidates,
  recoverStalledCrawlDispatches,
} from "../src/crawler/dispatch.js";
import { CRAWL_SCHEDULER_START_PATH } from "../src/crawler/orchestration.js";
import { SHOP_PLUGINS } from "../src/crawler/shops/index.js";
import { CRAWL_ROTATION_CRON, GENERAL_CRON, runScheduled } from "../src/scheduled.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase } from "./helpers/query-plan.js";

const PAUSE = Date.parse("2026-09-06T23:00:00+09:00");
const RESUME = Date.parse("2026-09-07T08:00:00+09:00");
const STORAGE_KEY = "phase2_crawl_execution"; // Public DO record name. gitleaks:allow

afterEach(() => vi.restoreAllMocks());

test("JST quiet hours include 23:00 and exclude 08:00 across UTC/date boundaries", () => {
  for (const [at, paused, next] of [
    [PAUSE - 1, false, PAUSE - 1],
    [PAUSE, true, RESUME],
    [Date.parse("2026-09-07T00:00:00+09:00"), true, RESUME],
    [RESUME - 1, true, RESUME],
    [RESUME, false, RESUME],
    [Date.parse("2026-09-07T09:00:00+09:00"), false, Date.parse("2026-09-07T00:00:00Z")],
  ] as const) {
    assert.equal(isCrawlQuietHours(at), paused);
    assert.equal(nextCrawlAllowedAt(at), next);
  }
  assert.equal(
    nextCrawlAllowedAt(Date.parse("2026-12-31T23:00:00+09:00")),
    Date.parse("2027-01-01T08:00:00+09:00"),
  );
});

test("collection age excludes only planned pauses, including multiple days", () => {
  const hour = 60 * 60_000;
  assert.equal(elapsedCrawlActiveMs(PAUSE, RESUME), 0);
  assert.equal(elapsedCrawlActiveMs(PAUSE - hour, RESUME + hour), 2 * hour);
  assert.equal(elapsedCrawlActiveMs(RESUME, RESUME + 3 * 24 * hour), 3 * 15 * hour);
  assert.equal(elapsedCrawlActiveMs(RESUME, PAUSE), 0);
});

function forbiddenEnv(): Env {
  return {
    ...Object.fromEntries(
      SHOP_PLUGINS.map((plugin) => [shopEnvVarName(plugin.definition, "ENABLED"), "true"]),
    ),
    DB: { prepare: () => assert.fail("unexpected D1 access during crawl pause") },
    CRAWL_RELAY_URL: "https://relay.example.test/",
    CRAWL_RELAY_TOKEN: "x".repeat(64),
  } as unknown as Env;
}

test("all shops skip scheduled, forced, due and recovery dispatch without D1 during the pause", async () => {
  const env = forbiddenEnv();
  const now = new Date(PAUSE);
  for (const plugin of SHOP_PLUGINS) {
    for (const dispatch of [dispatchScheduledCrawl, dispatchForcedCrawl]) {
      assert.deepEqual(await dispatch(env, plugin.key, { now }), {
        status: "skipped",
        reason: "crawl_quiet_hours",
        shopKey: plugin.key,
      });
    }
  }
  assert.deepEqual(dueDispatchCandidates(env, [], now), []);
  assert.deepEqual(await recoverStalledCrawlDispatches(env, { now }), []);
  assert.deepEqual(await dispatchDueCrawls(env, { now }), {
    status: "skipped",
    reason: "crawl_quiet_hours",
    queued: [],
  });
});

test("delayed daytime triggers and late nighttime triggers cannot bypass the pause", async () => {
  const clock = vi.spyOn(Date, "now");
  for (const cron of [CRAWL_ROTATION_CRON, "1,31 0-13,23 * * *", "30 12 * * *"]) {
    for (const [deliveredAt, scheduledAt] of [
      [PAUSE, PAUSE - 60_000],
      [RESUME, PAUSE],
    ]) {
      clock.mockReturnValue(deliveredAt!);
      assert.deepEqual(await runScheduled(cron, forbiddenEnv(), new Date(scheduledAt!)), {
        status: "skipped",
        reason: "crawl_quiet_hours",
        queued: [],
      });
    }
  }
});

test("general Cron still evaluates health but performs no crawl recovery overnight", async () => {
  vi.spyOn(Date, "now").mockReturnValue(PAUSE);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { db } = migratedSqlite();
  const recording = recordingDatabase(db);
  assert.deepEqual(await runScheduled(GENERAL_CRON, { DB: recording.db } as Env, new Date(PAUSE)), {
    status: "skipped",
    queued: [],
  });
  assert.equal(recording.executed.length, 1, "only the existing shop-health snapshot is read");
  assert.match(recording.executed[0]!.sql, /FROM shop_sync_state/);
});

test("old listing/detail/inventory Alarms keep their exact state and re-arm for 08:00 JST", async () => {
  vi.spyOn(Date, "now").mockReturnValue(PAUSE);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => assert.fail("seller I/O"));
  for (const plugin of SHOP_PLUGINS) {
    for (const phase of ["fetch", "finalize", "inventory"] as const) {
      const execution = {
        message: {
          shopKey: plugin.key,
          requestedAt: new Date(PAUSE - 60_000).toISOString(),
          force: true,
          jobId: "same-generation",
          collectionRunId: "same-run",
          continuation: { phase: phase === "inventory" ? "finalize" : phase, sequence: 7 },
        },
        inventoryRecheckPending: phase === "inventory",
        permit: { notBeforeMs: PAUSE - 1 },
      };
      const setAlarm = vi.fn();
      const ctx = {
        storage: {
          get: async () => structuredClone(execution),
          setAlarm,
          put: () => assert.fail("execution rewrite"),
          delete: () => assert.fail("execution deletion"),
        },
      };
      await new CrawlScheduler(ctx as unknown as DurableObjectState, forbiddenEnv()).alarm();
      assert.deepEqual(setAlarm.mock.calls, [[RESUME]]);
    }
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test("a new or replayed DO command received overnight is retained with a daytime Alarm", async () => {
  vi.spyOn(Date, "now").mockReturnValue(PAUSE);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const records = new Map<string, unknown>();
  const setAlarm = vi.fn();
  const ctx = {
    storage: {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: unknown) => {
        records.set(key, structuredClone(value));
      },
      setAlarm,
    },
  } as unknown as DurableObjectState;
  const scheduler = new CrawlScheduler(ctx, forbiddenEnv());
  const command = {
    schemaVersion: 1,
    type: "start_crawl",
    message: {
      shopKey: "home-shokai",
      force: true,
      requestedAt: new Date(PAUSE - 60_000).toISOString(),
      jobId: "same-generation",
    },
  };
  const request = () =>
    new Request(`https://scheduler${CRAWL_SCHEDULER_START_PATH}`, {
      method: "POST",
      body: JSON.stringify(command),
    });
  assert.equal((await scheduler.fetch(request())).status, 202);
  const stored = structuredClone(records.get(STORAGE_KEY));
  assert.equal((await scheduler.fetch(request())).status, 202);
  assert.deepEqual(records.get(STORAGE_KEY), stored);
  assert.deepEqual(setAlarm.mock.calls, [[RESUME], [RESUME]]);
});
