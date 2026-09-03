import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { NormalizedCatalogProduct } from "../src/catalog/types.js";
import {
  knownCrawlFetchPageKeys,
  nextPendingCrawlFetchPageKey,
  recordCrawlFetchPageFetched,
  recordCrawlFetchPageParsed,
} from "../src/db/crawl-fetch-page-repository.js";
import {
  ensureCrawlFetchSession,
  getCrawlFetchPage,
  getCrawlFetchSession,
} from "../src/db/crawl-fetch-session-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  assertNoGrowingTableScans,
  assertNoSortBeforeLimit,
  queryPlan,
  recordingDatabase,
  selects,
} from "./helpers/query-plan.js";

const AT = "2026-09-04T00:00:00.000Z";

function product(sourceId: string): NormalizedCatalogProduct {
  // The frontier repository serializes the already-normalized product and only depends on its
  // length for aggregate accounting. Keeping this fixture intentionally small makes the test about
  // crawl state rather than catalog normalization.
  return { sourceId } as NormalizedCatalogProduct;
}

async function createSession(pageCount = 1) {
  const migrated = migratedSqlite();
  await ensureCrawlFetchSession(migrated.db, {
    runId: "run-1",
    shopKey: "shop",
    requestedAt: AT,
    maxPages: Math.max(100, pageCount),
    pageLimit: Math.max(100, pageCount),
    pages: [{ key: "page-0", page: "page-0", ordinal: 0 }],
    createdAt: AT,
  });

  if (pageCount > 1) {
    const insert = migrated.sqlite.prepare(`
      INSERT INTO crawl_fetch_pages (run_id, page_key, page_json, ordinal, state)
      VALUES ('run-1', ?, ?, ?, 'pending')
    `);
    migrated.sqlite.exec("BEGIN");
    try {
      for (let ordinal = 1; ordinal < pageCount; ordinal += 1) {
        const key = `page-${ordinal}`;
        insert.run(key, JSON.stringify(key), ordinal);
      }
      migrated.sqlite
        .prepare(
          "UPDATE crawl_fetch_sessions SET frontier_count = ?, next_ordinal = ? WHERE run_id = 'run-1'",
        )
        .run(pageCount, pageCount);
      migrated.sqlite.exec("COMMIT");
    } catch (error) {
      migrated.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  return migrated;
}

test("one-page crawl advances aggregate state without rereading the frontier", async () => {
  const { db } = await createSession();

  await recordCrawlFetchPageFetched(db, {
    runId: "run-1",
    pageKey: "page-0",
    html: "<html />",
    htmlBytes: 8,
    fetchedAt: AT,
    currentSequence: 0,
  });
  await recordCrawlFetchPageParsed(db, {
    runId: "run-1",
    pageKey: "page-0",
    products: [product("source-1")],
    discoveredPages: [],
    parsedAt: AT,
    currentSequence: 1,
    nextPageKey: null,
    coverageIncomplete: false,
    reachedEnd: false,
  });

  const session = await getCrawlFetchSession(db, "run-1");
  assert.equal(session?.staged_item_count, 1);
  assert.equal(session?.frontier_count, 1);
  assert.equal(session?.next_ordinal, 1);
  assert.equal(session?.pages_fetched, 1);
  assert.equal(session?.pages_parsed, 1);
  assert.equal(session?.continuation_sequence, 2);
  assert.equal(session?.next_phase, "finalize");
});

test("parse replay and stale continuations cannot double-apply aggregates or cursor state", async () => {
  const { db } = await createSession();

  await recordCrawlFetchPageFetched(db, {
    runId: "run-1",
    pageKey: "page-0",
    html: "<html />",
    htmlBytes: 8,
    fetchedAt: AT,
    currentSequence: 0,
  });
  const parse = {
    runId: "run-1",
    pageKey: "page-0",
    products: [product("source-1")],
    discoveredPages: [{ key: "page-1", page: "page-1", ordinal: 1 }],
    parsedAt: AT,
    currentSequence: 1,
    nextPageKey: "page-1",
    coverageIncomplete: false,
    reachedEnd: false,
  } as const;

  await recordCrawlFetchPageParsed(db, parse);
  await recordCrawlFetchPageParsed(db, parse); // redelivery of the same continuation

  let session = await getCrawlFetchSession(db, "run-1");
  assert.equal(session?.staged_item_count, 1, "replay must not count staged products twice");
  assert.equal(session?.frontier_count, 2, "replay must not count discovery twice");
  assert.equal(session?.next_ordinal, 2, "replay must not consume a second ordinal");
  assert.equal(session?.pages_parsed, 1);
  assert.equal(session?.continuation_sequence, 2);
  assert.equal(session?.next_page_key, "page-1");

  // A stale fetch continuation is gated by the old sequence in SQL. It may not mutate the page
  // and then leave the session cursor behind, which is the dangerous half-applied state on replay.
  await recordCrawlFetchPageFetched(db, {
    runId: "run-1",
    pageKey: "page-1",
    html: "stale",
    htmlBytes: 5,
    fetchedAt: AT,
    currentSequence: 0,
  });
  assert.equal((await getCrawlFetchPage(db, "run-1", "page-1"))?.state, "pending");
  session = await getCrawlFetchSession(db, "run-1");
  assert.equal(session?.continuation_sequence, 2);

  await recordCrawlFetchPageFetched(db, {
    runId: "run-1",
    pageKey: "page-1",
    html: "fresh",
    htmlBytes: 5,
    fetchedAt: AT,
    currentSequence: 2,
  });
  assert.equal((await getCrawlFetchPage(db, "run-1", "page-1"))?.state, "fetched");
  assert.equal((await getCrawlFetchSession(db, "run-1"))?.continuation_sequence, 3);
});

test("duplicate discovery is detected with candidate-sized membership reads", async () => {
  const { db } = await createSession(100);

  const known = await knownCrawlFetchPageKeys(db, "run-1", [
    "page-1",
    "page-50",
    "page-99",
    "page-new",
    "page-50",
  ]);

  assert.deepEqual([...known].sort(), ["page-1", "page-50", "page-99"]);
});

for (const cardinality of [100, 1_000, 10_000] as const) {
  test(`next pending frontier read stays indexed and LIMIT-bounded at ${cardinality} pages`, async () => {
    const { sqlite, db } = await createSession(cardinality);
    // Make the first page no longer pending so the selector has to seek to the next pending ordinal.
    sqlite
      .prepare("UPDATE crawl_fetch_pages SET state = 'parsed' WHERE run_id = 'run-1' AND page_key = 'page-0'")
      .run();
    const recording = recordingDatabase(db);

    const next = await nextPendingCrawlFetchPageKey(recording.db, "run-1", "page-0");

    assert.equal(next, "page-1");
    assert.equal(selects(recording.executed).length, 1, "one bounded D1 SELECT per step");
    assertNoGrowingTableScans(sqlite, recording.executed, { label: `${cardinality}-page frontier` });
    assertNoSortBeforeLimit(sqlite, recording.executed, `${cardinality}-page frontier`);
    const plan = queryPlan(sqlite, selects(recording.executed)[0]!);
    assert.ok(
      plan.some(
        (step) =>
          /crawl_fetch_pages/u.test(step.detail) &&
          /USING (?:COVERING )?INDEX/u.test(step.detail) &&
          !/USE TEMP B-TREE/u.test(step.detail),
      ),
      `pending selector must use an index at ${cardinality} pages:\n${plan
        .map((step) => step.detail)
        .join("\n")}`,
    );
  });
}
