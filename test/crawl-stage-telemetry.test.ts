import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createCrawlStageRecorder } from "../src/crawler/crawl-stages.js";
import { crawlShop } from "../src/crawler/run.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { asQueryableDatabase } from "./helpers/d1.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

test("stage telemetry names the stage a run was in when it stopped", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line: string) => logs.push(line);
  console.warn = (line: string) => logs.push(line);
  let recorder;
  try {
    recorder = createCrawlStageRecorder("ippinkan", 42);
    await recorder.run("manufacturer_resolution", { inputCount: 745 }, async () => 745);
    assert.equal(recorder.lastCompletedStage, "manufacturer_resolution");
    assert.equal(recorder.activeStage, null);

    await assert.rejects(
      recorder.run(
        "identity_resolution",
        { inputCount: 745, failureEvent: "product_identity_sync_failure" },
        async () => {
          throw new Error("D1 timeout");
        },
      ),
    );
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  // A hard termination runs no catch block, so the failing stage has to survive on the recorder.
  assert.equal(recorder?.activeStage, "identity_resolution");
  assert.equal(recorder?.lastCompletedStage, "manufacturer_resolution");
  assert.ok(Number.isFinite(recorder?.stageDurationsMs().manufacturer_resolution));
  assert.equal(recorder?.stageDurationsMs().identity_resolution, undefined);

  const events = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    events.map((entry) => [entry.event, entry.stage]),
    [
      ["crawl_stage_start", "manufacturer_resolution"],
      ["crawl_stage_complete", "manufacturer_resolution"],
      ["crawl_stage_start", "identity_resolution"],
      ["product_identity_sync_failure", "identity_resolution"],
    ],
  );
  assert.equal(events[1].crawlRunId, 42);
  assert.equal(events[1].inputCount, 745);
  assert.ok(typeof events[1].durationMs === "number");
});

test("a stage without its own failure event reports the generic one", async () => {
  const warnings: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = (line: string) => warnings.push(line);
  try {
    const recorder = createCrawlStageRecorder("ippinkan", null);
    await assert.rejects(
      recorder.run("listing_write", {}, async () => {
        throw new Error("boom");
      }),
    );
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const event = JSON.parse(warnings[0]) as Record<string, unknown>;
  assert.equal(event.event, "crawl_stage_failure");
  assert.equal(event.crawlRunId, null);
  assert.equal(event.message, "boom");
});

/** A database that fails one statement, standing in for a D1 error outside the page loop. */
function databaseFailingOn(db: QueryableDatabase, pattern: RegExp): QueryableDatabase {
  return asQueryableDatabase({
    prepare(sql: string) {
      if (pattern.test(sql)) throw new Error("D1 unavailable");
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  });
}

test("a failure before the page loop still reaches shop health", async () => {
  const { sqlite, db } = migratedSqlite();
  const plugin = getShopPlugin("home-shokai");
  assert.ok(plugin);
  const env = {
    DB: databaseFailingOn(db, /INSERT INTO crawl_runs/u),
  } as unknown as Parameters<typeof crawlShop>[0];

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await crawlShop(env, plugin, {
      force: true,
      now: new Date("2026-08-25T12:00:00.000Z"),
      fetchFn: () => {
        throw new Error("the seller must never be reached in this case");
      },
    });
  } finally {
    console.warn = originalWarn;
  }

  // Run creation used to sit outside the try, so this exception escaped `crawlShop` entirely and
  // left the shop with an advanced attempt, no error timestamp and an unchanged failure count.
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.crawlRunId, null);
  const state = sqlite
    .prepare(
      "SELECT last_attempt_at, last_error_at, consecutive_failures FROM shop_sync_state WHERE shop_key = ?",
    )
    .get("home-shokai") as {
    last_attempt_at: string | null;
    last_error_at: string | null;
    consecutive_failures: number;
  };
  assert.equal(state.last_attempt_at, "2026-08-25T12:00:00.000Z");
  assert.ok(state.last_error_at, "the interrupted attempt is recorded as a failure");
  assert.equal(state.consecutive_failures, 1);
});
