import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  recoverStalledCrawlRuns,
  shouldRecordStalledRunFailure,
} from "../src/crawler/crawl-run-recovery.js";
import type { CrawlDispatchStateRow } from "../src/crawler/crawl-lifecycle.js";
import { crawlDispatchToken } from "../src/db/shop-state-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { shopSyncStateRow } from "./helpers/fixtures.js";

type Sqlite = ReturnType<typeof migratedSqlite>["sqlite"];

const NOW = new Date("2026-08-25T12:00:00.000Z");
/** Older than the conservative stalled-run window plus recovery grace. */
const ABANDONED_AT = "2026-08-25T11:00:00.000Z";
const RECENT_AT = "2026-08-25T11:58:00.000Z";

function lifecycleRow(
  overrides: Partial<CrawlDispatchStateRow> & { shop_key: string },
): CrawlDispatchStateRow {
  return {
    ...shopSyncStateRow({ shop_key: overrides.shop_key }),
    dispatch_requested_at: null,
    dispatch_token: null,
    dispatch_last_sent_at: null,
    ...overrides,
  };
}

function insertRun(sqlite: Sqlite, shopKey: string, startedAt: string, status = "running"): number {
  return Number(
    sqlite
      .prepare("INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, ?)")
      .run(shopKey, startedAt, status).lastInsertRowid,
  );
}

function insertShopState(
  sqlite: Sqlite,
  row: Partial<CrawlDispatchStateRow> & { shop_key: string },
) {
  sqlite
    .prepare(`
      INSERT INTO shop_sync_state (
        shop_key, last_attempt_at, last_success_at, last_error_at, consecutive_failures,
        dispatch_requested_at, dispatch_token, dispatch_last_sent_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.shop_key,
      row.last_attempt_at ?? null,
      row.last_success_at ?? null,
      row.last_error_at ?? null,
      row.consecutive_failures ?? 0,
      row.dispatch_requested_at ?? null,
      row.dispatch_token ?? null,
      row.dispatch_last_sent_at ?? null,
    );
}

function readRun(sqlite: Sqlite, runId: number) {
  return sqlite
    .prepare("SELECT status, finished_at, message FROM crawl_runs WHERE id = ?")
    .get(runId) as { status: string; finished_at: string | null; message: string };
}

function readShopState(sqlite: Sqlite, shopKey: string) {
  return sqlite
    .prepare(
      "SELECT last_error_at, consecutive_failures, backoff_until FROM shop_sync_state WHERE shop_key = ?",
    )
    .get(shopKey) as {
    last_error_at: string | null;
    consecutive_failures: number;
    backoff_until: string | null;
  };
}

test("an abandoned run is closed and charged to shop health", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = insertRun(sqlite, "ippinkan", ABANDONED_AT);
  insertShopState(sqlite, {
    shop_key: "ippinkan",
    last_attempt_at: ABANDONED_AT,
    last_success_at: "2026-08-22T10:31:00.000Z",
    last_error_at: "2026-08-24T18:26:00.000Z",
    consecutive_failures: 2,
  });

  const recovered = await recoverStalledCrawlRuns(db, { now: NOW });

  assert.deepEqual(recovered, [
    {
      crawlRunId: runId,
      shopKey: "ippinkan",
      startedAt: ABANDONED_AT,
      recordedFailure: true,
    },
  ]);
  const run = readRun(sqlite, runId);
  assert.equal(run.status, "failed");
  assert.equal(run.finished_at, NOW.toISOString());
  assert.match(run.message, /abandoned/u);

  const state = readShopState(sqlite, "ippinkan");
  assert.equal(state.last_error_at, NOW.toISOString());
  assert.equal(state.consecutive_failures, 3);
  assert.ok(state.backoff_until, "a recorded failure applies the normal backoff");
});

test("a recent run is left alone", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = insertRun(sqlite, "ippinkan", RECENT_AT);
  insertShopState(sqlite, { shop_key: "ippinkan", last_attempt_at: RECENT_AT });

  assert.deepEqual(await recoverStalledCrawlRuns(db, { now: NOW }), []);
  assert.equal(readRun(sqlite, runId).status, "running");
});

test("a finished run is never reopened or recharged", async () => {
  const { sqlite, db } = migratedSqlite();
  const success = insertRun(sqlite, "ippinkan", ABANDONED_AT, "success");
  insertShopState(sqlite, { shop_key: "ippinkan", last_success_at: NOW.toISOString() });

  assert.deepEqual(await recoverStalledCrawlRuns(db, { now: NOW }), []);
  assert.equal(readRun(sqlite, success).status, "success");
  assert.equal(readShopState(sqlite, "ippinkan").consecutive_failures, 0);
});

test("recovery closes the run but leaves health to the outcome already recorded after it", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = insertRun(sqlite, "ippinkan", ABANDONED_AT);
  insertShopState(sqlite, {
    shop_key: "ippinkan",
    last_attempt_at: "2026-08-25T11:40:00.000Z",
    last_success_at: "2026-08-25T11:45:00.000Z",
    consecutive_failures: 0,
  });

  const recovered = await recoverStalledCrawlRuns(db, { now: NOW });

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].recordedFailure, false);
  assert.equal(readRun(sqlite, runId).status, "failed");
  assert.equal(readShopState(sqlite, "ippinkan").consecutive_failures, 0);
});

test("an active Durable Object dispatch keeps ownership of its own outcome", () => {
  const run = {
    id: 1,
    shop_key: "ippinkan",
    started_at: ABANDONED_AT,
    current_stage: "fetch_parse",
    pages_done: 3,
    last_progress_at: ABANDONED_AT,
  };
  const token = crawlDispatchToken("ippinkan", ABANDONED_AT);
  const dispatched = lifecycleRow({
    shop_key: "ippinkan",
    dispatch_requested_at: ABANDONED_AT,
    dispatch_token: token,
    dispatch_last_sent_at: ABANDONED_AT,
  });
  assert.equal(shouldRecordStalledRunFailure(dispatched, run, NOW), false);

  const idle = lifecycleRow({ shop_key: "ippinkan" });
  assert.equal(shouldRecordStalledRunFailure(idle, run, NOW), true);
  assert.equal(shouldRecordStalledRunFailure(undefined, run, NOW), false);
});

test("recovery drains a backlog in bounded batches", async () => {
  const { sqlite, db } = migratedSqlite();
  for (let index = 0; index < 5; index += 1) {
    insertRun(sqlite, `shop-${index}`, ABANDONED_AT);
  }

  const first = await recoverStalledCrawlRuns(db, { now: NOW, limit: 2 });
  assert.equal(first.length, 2);
  const second = await recoverStalledCrawlRuns(db, { now: NOW, limit: 2 });
  assert.equal(second.length, 2);
  assert.deepEqual(
    new Set([...first, ...second].map((entry) => entry.crawlRunId)).size,
    4,
    "a recovered run is never handed out twice",
  );
});

test("an abandoned run reports the stage and page count it stopped at", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = insertRun(sqlite, "ippinkan", ABANDONED_AT);
  sqlite
    .prepare(
      "UPDATE crawl_runs SET current_stage = ?, pages_done = ?, last_progress_at = ? WHERE id = ?",
    )
    .run("fetch_parse", 11, "2026-08-25T11:03:00.000Z", runId);
  insertShopState(sqlite, { shop_key: "ippinkan", last_attempt_at: ABANDONED_AT });

  await recoverStalledCrawlRuns(db, { now: NOW });

  const { message } = readRun(sqlite, runId);
  assert.match(message, /^crawl run abandoned: no terminal outcome recorded/u);
  assert.match(message, /stage=fetch_parse/u);
  assert.match(message, /pagesDone=11/u);
  assert.match(message, /lastProgressAt=2026-08-25T11:03:00\.000Z/u);
});

test("a run abandoned before its first heartbeat says so", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = insertRun(sqlite, "ippinkan", ABANDONED_AT);
  insertShopState(sqlite, { shop_key: "ippinkan", last_attempt_at: ABANDONED_AT });

  await recoverStalledCrawlRuns(db, { now: NOW });

  const { message } = readRun(sqlite, runId);
  assert.match(message, /stage=none/u);
  assert.match(message, /pagesDone=0/u);
});
