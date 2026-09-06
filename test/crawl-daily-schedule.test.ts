import assert from "node:assert/strict";
import { afterEach, test, vi } from "vite-plus/test";
import { shopEnvVarName } from "../src/config.js";
import type { CrawlDispatchMessage } from "../src/crawler/orchestration.js";
import { shopsInDailyRotation } from "../src/crawler/schedule.js";
import { releaseShopDispatch } from "../src/db/shop-state-repository.js";
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

test("two full JST days dispatch every daily shop once even after completed runs release their token", async () => {
  const clock = vi.spyOn(Date, "now");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { db } = migratedSqlite();
  const recording = recordingDatabase(db);
  const sent: CrawlDispatchMessage[] = [];
  const env = dailyEnv(recording.db, sent);
  const dailyShops = shopsInDailyRotation();
  const firstTick = Date.parse("2026-12-31T08:06:00+09:00");

  for (let day = 0; day < 2; day += 1) {
    const start = sent.length;
    // All 90 production rotation firings between 08:06 and 22:56 JST. Delivery is late,
    // but the scheduled time must select the shop and define its immutable dispatch token.
    for (let tick = 0; tick < 90; tick += 1) {
      const scheduledAt = new Date(firstTick + day * 24 * 60 * 60_000 + tick * 10 * 60_000);
      clock.mockReturnValue(scheduledAt.getTime() + 30_000);
      const before = recording.executed.length;
      const result = await runScheduled(CRAWL_ROTATION_CRON, env, scheduledAt);
      if (result.status === "queued") {
        const message = sent.at(-1)!;
        assert.equal(message.requestedAt, scheduledAt.toISOString());
        // Model completion, so a repeated pass cannot hide behind an active reservation.
        await releaseShopDispatch(db, message.shopKey, message.jobId!);
      } else {
        assert.deepEqual(result, { status: "skipped", queued: [] });
        assert.equal(recording.executed.length, before, "idle ticks must not access D1");
      }
    }
    assert.deepEqual(
      sent.slice(start).map((message) => message.shopKey),
      dailyShops.map((plugin) => plugin.key),
    );
  }
  for (let index = 0; index < dailyShops.length; index += 1) {
    assert.equal(
      Date.parse(sent[index + dailyShops.length]!.requestedAt) -
        Date.parse(sent[index]!.requestedAt),
      24 * 60 * 60_000,
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
  for (const at of ["2026-09-06T11:06:00+09:00", "2026-09-06T11:16:00+09:00"]) {
    const scheduledAt = new Date(at);
    clock.mockReturnValue(scheduledAt.getTime());
    await runScheduled(CRAWL_ROTATION_CRON, env, scheduledAt);
  }
  assert.deepEqual(
    sent.map((message) => message.shopKey),
    ["home-shokai"],
  );
});
