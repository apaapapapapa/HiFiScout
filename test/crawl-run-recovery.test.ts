import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  recoverStalledCrawlRuns,
  shouldRecordStalledRunFailure,
} from "../src/crawler/crawl-run-recovery.js";
import type { CrawlLifecycleRow } from "../src/crawler/crawl-lifecycle.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { shopSyncStateRow } from "./helpers/fixtures.js";

type Sqlite = ReturnType<typeof migratedSqlite>["sqlite"];

const NOW = new Date("2026-08-25T12:00:00.000Z");
/** Older than the twenty-minute execution lease plus the recovery grace. */
const ABANDONED_AT = "2026-08-25T11:00:00.000Z";
const RECENT_AT = "2026-08-25T11:58:00.000Z";

function lifecycleRow(overrides: Partial<CrawlLifecycleRow> & { shop_key: string }) {
  return {
    ...shopSyncStateRow({ shop_key: overrides.shop_key }),
    queued_token: null,
    queued_last_sent_at: null,
    crawl_lease_token: null,
    crawl_lease_until: null,
    ...overrides,
  } as CrawlLifecycleRow;
}

function insertRun(sqlite: Sqlite, shopKey: string, startedAt: string, status = "running"): number {
  return Number(
    sqlite
      .prepare("INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, ?)")
      .run(shopKey, startedAt, status).lastInsertRowid,
  );
}

function insertShopState(sqlite: Sqlite, row: Partial<CrawlLifecycleRow> & { shop_key: string }) {
  sqlite
    .prepare(`
      INSERT INTO shop_sync_state (
        shop_key, last_attempt_at, last_success_at, last_error_at, consecutive_failures,
        crawl_lease_token, crawl_lease_until, queued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.shop_key,
      row.last_attempt_at ?? null,
      row.last_success_at ?? null,
      row.last_error_at ?? null,
      row.consecutive_failures ?? 0,
      row.crawl_lease_token ?? null,
      row.crawl_lease_until ?? null,
      row.queued_at ?? null,
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

  // The incident's signature was an attempt that never became a failure, so health never moved.
  const state = readShopState(sqlite, "ippinkan");
  assert.equal(state.last_error_at, NOW.toISOString());
  assert.equal(state.consecutive_failures, 3);
  assert.ok(state.backoff_until, "a recorded failure applies the normal backoff");
});

test("a run younger than the execution lease is left alone", async () => {
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
  // A later crawl already succeeded, so this abandoned row is history, not the open question.
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

test("a shop still holding an execution lease keeps its own outcome", () => {
  const run = { id: 1, shop_key: "ippinkan", started_at: ABANDONED_AT };
  const executing = lifecycleRow({
    shop_key: "ippinkan",
    queued_at: ABANDONED_AT,
    crawl_lease_token: "lease",
    crawl_lease_until: "2026-08-25T12:10:00.000Z",
  });
  assert.equal(shouldRecordStalledRunFailure(executing, run, NOW), false);

  const expired = lifecycleRow({
    ...executing,
    crawl_lease_until: "2026-08-25T11:10:00.000Z",
  });
  assert.equal(shouldRecordStalledRunFailure(expired, run, NOW), true);
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
