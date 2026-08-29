import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { finishCrawlRunSuccess, startCrawlRun } from "../src/db/crawl-run-repository.js";
import {
  claimCrawlFetchFinalization,
  deleteTerminalCrawlFetchSessions,
  ensureCrawlFetchSession,
  failCrawlFetchSession,
  getCrawlFetchPage,
  getCrawlFetchSession,
} from "../src/db/crawl-fetch-session-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const REQUESTED_AT = "2026-08-29T00:00:00.000Z";
const PAGE_KEY = "https://example.test/used?page=1";

async function createSession(db: ReturnType<typeof migratedSqlite>["db"], runId: string) {
  return ensureCrawlFetchSession(db, {
    runId,
    shopKey: "test-shop",
    requestedAt: REQUESTED_AT,
    maxPages: 50,
    pageLimit: 50,
    pages: [{ key: PAGE_KEY, page: PAGE_KEY, ordinal: 0 }],
    createdAt: REQUESTED_AT,
  });
}

test("redelivery repairs a session row left without its initial frontier", async () => {
  const { sqlite, db } = migratedSqlite();
  sqlite
    .prepare(`
      INSERT INTO crawl_fetch_sessions (
        run_id, shop_key, requested_at, status, max_pages, page_limit,
        continuation_sequence, next_phase, next_page_key, created_at, updated_at
      ) VALUES (?, ?, ?, 'collecting', 50, 50, 0, 'fetch', ?, ?, ?)
    `)
    .run("repair-run", "test-shop", REQUESTED_AT, PAGE_KEY, REQUESTED_AT, REQUESTED_AT);

  assert.equal(await getCrawlFetchSession(db, "repair-run"), null);

  const repaired = await createSession(db, "repair-run");
  assert.equal(repaired.created, false);
  assert.equal(repaired.session.next_page_key, PAGE_KEY);
  assert.ok(await getCrawlFetchPage(db, "repair-run", PAGE_KEY));
});

test("a reclaimed finalizer reuses one logical crawl run and reconciles its terminal outcome", async () => {
  const { sqlite, db } = migratedSqlite();
  await createSession(db, "finalize-run");
  sqlite
    .prepare(`
      UPDATE crawl_fetch_sessions
      SET next_phase = 'finalize', next_page_key = NULL, updated_at = ?
      WHERE run_id = ?
    `)
    .run(REQUESTED_AT, "finalize-run");

  const firstClaim = await claimCrawlFetchFinalization(
    db,
    "finalize-run",
    "2026-08-29T00:01:00.000Z",
    "2026-08-28T23:59:00.000Z",
  );
  assert.equal(firstClaim, true);

  const firstRunId = await startCrawlRun(db, "test-shop", "2026-08-29T00:01:00.100Z");
  const secondRunId = await startCrawlRun(db, "test-shop", "2026-08-29T00:01:00.200Z");
  assert.equal(secondRunId, firstRunId);
  assert.equal(
    Number(sqlite.prepare("SELECT COUNT(*) AS count FROM crawl_runs").get()?.count),
    1,
  );

  await finishCrawlRunSuccess(db, firstRunId, {
    finishedAt: "2026-08-29T00:01:30.000Z",
    itemCount: 10,
    pageCount: 1,
    message: "ok",
  });

  const reclaimed = await claimCrawlFetchFinalization(
    db,
    "finalize-run",
    "2026-08-29T00:04:00.000Z",
    "2026-08-29T00:02:00.000Z",
  );
  assert.equal(reclaimed, false);
  const session = await getCrawlFetchSession(db, "finalize-run");
  assert.equal(session?.status, "completed");
  assert.equal(session?.final_crawl_run_id, firstRunId);
  assert.equal(
    Number(sqlite.prepare("SELECT COUNT(*) AS count FROM crawl_runs").get()?.count),
    1,
  );
});

test("failed sessions immediately discard staged HTML and product payloads", async () => {
  const { sqlite, db } = migratedSqlite();
  await createSession(db, "failed-run");
  sqlite
    .prepare(`
      UPDATE crawl_fetch_pages
      SET html_text = '<html>large payload</html>', products_json = '[{"sourceId":"x"}]'
      WHERE run_id = ?
    `)
    .run("failed-run");

  await failCrawlFetchSession(db, {
    runId: "failed-run",
    failedAt: "2026-08-29T00:05:00.000Z",
    message: "expected failure",
  });

  const page = await getCrawlFetchPage(db, "failed-run", PAGE_KEY);
  assert.equal(page?.html_text, null);
  assert.equal(page?.products_json, null);
});

test("terminal session retention deletes its page frontier through cascade", async () => {
  const { sqlite, db } = migratedSqlite();
  sqlite.exec("PRAGMA foreign_keys = ON");
  await createSession(db, "old-run");
  await failCrawlFetchSession(db, {
    runId: "old-run",
    failedAt: "2026-07-01T00:00:00.000Z",
    message: "old failure",
  });

  const deleted = await deleteTerminalCrawlFetchSessions(db, {
    finalizedBefore: "2026-07-30T00:00:00.000Z",
    limit: 500,
  });
  assert.equal(deleted, 1);
  assert.equal(
    Number(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM crawl_fetch_sessions WHERE run_id = ?")
        .get("old-run")?.count,
    ),
    0,
  );
  assert.equal(
    Number(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM crawl_fetch_pages WHERE run_id = ?")
        .get("old-run")?.count,
    ),
    0,
  );
});
