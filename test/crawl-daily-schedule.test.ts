import assert from "node:assert/strict";
import { afterEach, test, vi } from "vite-plus/test";
import { shopEnvVarName } from "../src/config.js";
import type { CrawlDispatchMessage } from "../src/crawler/orchestration.js";
import { shopsInDailyRotation } from "../src/crawler/schedule.js";
import { markShopAttempt, releaseShopDispatch } from "../src/db/shop-state-repository.js";
import { CRAWL_ROTATION_CRON, runScheduled } from "../src/scheduled.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase } from "./helpers/query-plan.js";

afterEach(() => vi.restoreAllMocks());

function dailyEnv(
  db: ReturnType<typeof migratedSqlite>["db"],
  sent: CrawlDispatchMessage[],
  settings: Record<string, string> = {},
): Env {
  return {
    ...Object.fromEntries(
      shopsInDailyRotation().map((plugin) => [
        shopEnvVarName(plugin.definition, "ENABLED"),
        "true",
      ]),
    ),
    ...settings,
    DB: db,
    CRAWL_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const command = JSON.parse(String(init.body)) as { message: CrawlDispatchMessage };
          sent.push(command.message);
          return new Response(null, { status: 202 });
        },
      }),
    },
  } as unknown as Env;
}

test("each JST day dispatches every shared shop once at 11:00 and once at 17:00, ignoring the rolling interval", async () => {
  const clock = vi.spyOn(Date, "now");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { db } = migratedSqlite();
  const recording = recordingDatabase(db);
  const sent: CrawlDispatchMessage[] = [];
  const env = dailyEnv(recording.db, sent);
  const dailyShops = shopsInDailyRotation();
  const firstTick = Date.parse("2026-12-31T11:00:00+09:00");

  for (let day = 0; day < 2; day += 1) {
    const start = sent.length;
    // All 72 production rotation firings between 11:00 and 22:50 JST. Delivery is late,
    // but the scheduled time must select the shop and define its immutable dispatch token.
    for (let tick = 0; tick < 72; tick += 1) {
      const scheduledAt = new Date(firstTick + day * 24 * 60 * 60_000 + tick * 10 * 60_000);
      clock.mockReturnValue(scheduledAt.getTime() + 30_000);
      const before = recording.executed.length;
      const result = await runScheduled(CRAWL_ROTATION_CRON, env, scheduledAt);
      if (result.status === "queued") {
        const message = sent.at(-1)!;
        assert.equal(message.requestedAt, scheduledAt.toISOString());
        // Model a real attempt and completion. The 17:00 pass must still run only six hours
        // later, and a repeated pass cannot hide behind an active reservation.
        await markShopAttempt(db, message.shopKey, scheduledAt.toISOString());
        await releaseShopDispatch(db, message.shopKey, message.jobId!);
      } else {
        assert.deepEqual(result, { status: "skipped", queued: [] });
        assert.equal(recording.executed.length, before, "idle ticks must not access D1");
      }
    }
    assert.deepEqual(
      sent.slice(start).map((message) => message.shopKey),
      [...dailyShops, ...dailyShops].map((plugin) => plugin.key),
    );
  }
  const passSize = dailyShops.length;
  assert.equal(new Set(sent.map((message) => message.jobId)).size, 4 * passSize);
  for (let index = 0; index < passSize; index += 1) {
    for (let pass = 0; pass < 4; pass += 1) {
      assert.equal(
        Date.parse(sent[pass * passSize + index]!.requestedAt),
        firstTick +
          Math.floor(pass / 2) * 24 * 60 * 60_000 +
          (pass % 2) * 6 * 60 * 60_000 +
          index * 10 * 60_000,
      );
    }
    assert.equal(
      Date.parse(sent[2 * passSize + index]!.requestedAt) -
        Date.parse(sent[passSize + index]!.requestedAt),
      18 * 60 * 60_000,
    );
  }
});

test("disabled daily shops keep their slot without moving or repeating the next shop", async () => {
  const clock = vi.spyOn(Date, "now");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { db } = migratedSqlite();
  const sent: CrawlDispatchMessage[] = [];
  const env = dailyEnv(db, sent, { REWIRE_ENABLED: "false" });
  for (const at of [
    "2026-09-06T13:00:00+09:00",
    "2026-09-06T13:10:00+09:00",
    "2026-09-06T19:00:00+09:00",
    "2026-09-06T19:10:00+09:00",
  ]) {
    const scheduledAt = new Date(at);
    clock.mockReturnValue(scheduledAt.getTime());
    const result = await runScheduled(CRAWL_ROTATION_CRON, env, scheduledAt);
    if (result.status === "queued") {
      const message = sent.at(-1)!;
      await releaseShopDispatch(db, message.shopKey, message.jobId!);
    }
  }
  assert.deepEqual(
    sent.map((message) => message.shopKey),
    ["home-shokai", "home-shokai"],
  );
});

test("delayed events keep their original slot and the superseded cron cannot add another pass", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-06T17:15:00+09:00"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { db } = migratedSqlite();
  const recording = recordingDatabase(db);
  const sent: CrawlDispatchMessage[] = [];
  const env = dailyEnv(recording.db, sent);
  const scheduledAt = new Date("2026-09-06T13:10:00+09:00");
  assert.deepEqual(await runScheduled(CRAWL_ROTATION_CRON, env, scheduledAt), {
    status: "queued",
    shopKey: "home-shokai",
  });
  assert.equal(sent[0]?.requestedAt, scheduledAt.toISOString());
  const before = recording.executed.length;
  assert.deepEqual(
    await runScheduled("6-56/10 0-13,23 * * *", env, new Date("2026-09-06T13:16:00+09:00")),
    { status: "skipped", queued: [] },
  );
  assert.equal(sent.length, 1);
  assert.equal(recording.executed.length, before);
});
