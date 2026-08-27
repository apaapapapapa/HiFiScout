import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createCrawlRunProgressRecorder } from "../src/crawler/crawl-progress.js";
import { createInvocationDeadline } from "../src/deadline.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { asQueryableDatabase } from "./helpers/d1.js";

type Sqlite = ReturnType<typeof migratedSqlite>["sqlite"];

function openRun(sqlite: Sqlite, shopKey = "ippinkan"): number {
  return Number(
    sqlite
      .prepare("INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, 'running')")
      .run(shopKey, "2026-08-25T11:00:00.000Z").lastInsertRowid,
  );
}

function readProgress(sqlite: Sqlite, runId: number) {
  return sqlite
    .prepare("SELECT current_stage, pages_done, last_progress_at FROM crawl_runs WHERE id = ?")
    .get(runId) as { current_stage: string; pages_done: number; last_progress_at: string | null };
}

test("the page count survives the move to a later stage", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = openRun(sqlite);
  const progress = createCrawlRunProgressRecorder(db, runId, {
    deadline: createInvocationDeadline(60_000),
  });

  await progress.record("fetch_parse", 0);
  await progress.record("fetch_parse", 17);
  await progress.record("listing_write");

  // A run that dies in the listing write still has to be able to say it read seventeen pages.
  const row = readProgress(sqlite, runId);
  assert.equal(row.current_stage, "listing_write");
  assert.equal(row.pages_done, 17);
});

test("heartbeats are throttled inside a stage but never across one", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = openRun(sqlite);
  let clock = Date.parse("2026-08-25T11:00:00.000Z");
  const progress = createCrawlRunProgressRecorder(db, runId, {
    deadline: createInvocationDeadline(60_000),
    minIntervalMs: 5_000,
    now: () => new Date(clock),
  });

  await progress.record("fetch_parse", 1);
  clock += 1_000;
  await progress.record("fetch_parse", 2);
  assert.equal(readProgress(sqlite, runId).pages_done, 1, "the second page is inside the throttle");

  clock += 5_000;
  await progress.record("fetch_parse", 3);
  assert.equal(readProgress(sqlite, runId).pages_done, 3);

  // A stage change is the one event that must never be throttled away: it is what the recovery
  // sweep reads to say where the run stopped.
  clock += 10;
  await progress.record("manufacturer_resolution");
  assert.equal(readProgress(sqlite, runId).current_stage, "manufacturer_resolution");
});

test("a heartbeat that cannot be written never fails the crawl", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = openRun(sqlite);
  const failing = asQueryableDatabase({
    prepare(sql: string) {
      if (/UPDATE crawl_runs/u.test(sql)) throw new Error("D1 unavailable");
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  });
  const progress = createCrawlRunProgressRecorder(failing, runId, {
    deadline: createInvocationDeadline(60_000),
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line: string) => warnings.push(line);
  try {
    // Diagnostics explain a failure; they must not be able to become one.
    await progress.record("fetch_parse", 1);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(JSON.parse(warnings[0]).event, "crawl_run_progress_failure");
  assert.equal(readProgress(sqlite, runId).current_stage, "");
});

test("a run with no id records nothing at all", async () => {
  const { db } = migratedSqlite();
  const progress = createCrawlRunProgressRecorder(db, null, {
    deadline: createInvocationDeadline(60_000),
  });
  await progress.record("fetch_parse", 3);
});
