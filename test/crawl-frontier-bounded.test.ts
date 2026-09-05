import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { NormalizedCatalogProduct } from "../src/catalog/types.js";
import {
  crawlFetchFrontierProbe,
  knownCrawlFetchPageKeys,
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

/**
 * What a resumable crawl costs as its frontier grows.
 *
 * Every page step needs three facts about the rest of the run: the ordinal a discovered page should
 * take, whether anything has been staged yet, and which page comes next. Materializing the frontier
 * to answer them made a P-page crawl read `1 + 2 + ... + P` rows -- O(P^2) for a crawl that fetches
 * P pages once each.
 *
 * They now come from one statement of three index seeks. It reads `crawl_fetch_pages` rather than
 * aggregates cached on the session, which is what makes it safe across a deployment: D1 migrations
 * are applied before the new Worker ships, so a cached aggregate spends that window being maintained
 * by nobody. The tests below pin both halves -- the cost, and the fact that a Worker which knows
 * nothing about the new code cannot leave the frontier in a state the new code misreads.
 */

const AT = "2026-09-04T00:00:00.000Z";

function product(sourceId: string): NormalizedCatalogProduct {
  // The frontier repository serializes the already-normalized product and only depends on its
  // length for accounting. Keeping this fixture intentionally small makes the test about crawl
  // state rather than catalog normalization.
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

  if (pageCount > 1) addPendingPages(migrated.sqlite, 1, pageCount);
  return migrated;
}

/** Pages appended straight to D1, as a Worker of any version leaves them. */
function addPendingPages(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  from: number,
  to: number,
): void {
  const insert = sqlite.prepare(`
    INSERT INTO crawl_fetch_pages (run_id, page_key, page_json, ordinal, state)
    VALUES ('run-1', ?, ?, ?, 'pending')
  `);
  sqlite.exec("BEGIN");
  try {
    for (let ordinal = from; ordinal < to; ordinal += 1) {
      const key = `page-${ordinal}`;
      insert.run(key, JSON.stringify(key), ordinal);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

test("one-page crawl advances its cursor without rereading the frontier", async () => {
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
  assert.equal(session?.pages_fetched, 1);
  assert.equal(session?.pages_parsed, 1);
  assert.equal(session?.continuation_sequence, 2);
  assert.equal(session?.next_phase, "finalize");

  const frontier = await crawlFetchFrontierProbe(db, "run-1");
  assert.equal(frontier.nextOrdinal, 1);
  assert.equal(frontier.hasStagedItems, true);
  assert.equal(frontier.nextPendingPageKey, null);
});

test("parse replay and stale continuations cannot double-apply page or cursor state", async () => {
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
  assert.equal(session?.pages_parsed, 1, "replay must not count the page twice");
  assert.equal(session?.continuation_sequence, 2);
  assert.equal(session?.next_page_key, "page-1");

  // The frontier is what the next step reads, so the replay has to be invisible there too.
  const frontier = await crawlFetchFrontierProbe(db, "run-1", "page-0");
  assert.equal(frontier.nextOrdinal, 2, "replay must not consume a second ordinal");
  assert.equal(frontier.nextPendingPageKey, "page-1");

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

test("pages appended by a Worker that knows nothing of this code are still seen", async () => {
  // The deployment window this design exists for. Migrations run before the new Worker ships, so
  // between the two only the previous Worker is writing -- and it maintains nothing but
  // `crawl_fetch_pages`. Anything derived from a cached aggregate would be stale here: the next
  // ordinal would collide with a page already at that ordinal, the discovered page would be dropped
  // by the uniqueness constraint, and the session would advance to a page that does not exist.
  const { sqlite, db } = await createSession(3);
  await recordCrawlFetchPageFetched(db, {
    runId: "run-1",
    pageKey: "page-0",
    html: "<html />",
    htmlBytes: 8,
    fetchedAt: AT,
    currentSequence: 0,
  });

  // The other Worker extends the frontier and stages products, touching no aggregate anywhere.
  sqlite
    .prepare("UPDATE crawl_fetch_pages SET state = 'parsed', item_count = 4 WHERE page_key = ?")
    .run("page-2");
  addPendingPages(sqlite, 3, 6);

  const frontier = await crawlFetchFrontierProbe(db, "run-1", "page-0");

  assert.equal(frontier.nextOrdinal, 6, "the ordinal after the last page the other Worker added");
  assert.equal(frontier.hasStagedItems, true, "items it staged count as staged");
  assert.equal(frontier.nextPendingPageKey, "page-1");

  // And the ordinal it hands out is genuinely free: the insert lands rather than being ignored.
  await recordCrawlFetchPageParsed(db, {
    runId: "run-1",
    pageKey: "page-0",
    products: [product("source-1")],
    discoveredPages: [{ key: "page-6", page: "page-6", ordinal: frontier.nextOrdinal }],
    parsedAt: AT,
    currentSequence: 1,
    nextPageKey: "page-1",
    coverageIncomplete: false,
    reachedEnd: false,
  });
  const inserted = await getCrawlFetchPage(db, "run-1", "page-6");
  assert.equal(inserted?.ordinal, 6, "the discovered page was stored, not dropped on a collision");
});

test("a run that has staged nothing is distinguished from one that has", async () => {
  // `hasStagedItems` decides whether an empty page means the shop ran out or simply had none yet.
  const { sqlite, db } = await createSession(3);

  assert.equal((await crawlFetchFrontierProbe(db, "run-1")).hasStagedItems, false);

  sqlite
    .prepare("UPDATE crawl_fetch_pages SET state = 'parsed', item_count = 0 WHERE page_key = ?")
    .run("page-0");
  assert.equal(
    (await crawlFetchFrontierProbe(db, "run-1")).hasStagedItems,
    false,
    "a parsed page with no products has not staged anything",
  );

  sqlite
    .prepare("UPDATE crawl_fetch_pages SET state = 'parsed', item_count = 7 WHERE page_key = ?")
    .run("page-1");
  assert.equal((await crawlFetchFrontierProbe(db, "run-1")).hasStagedItems, true);
});

test("the next pending page is the lowest ordinal, not the lowest key", async () => {
  // Crawl order is ordinal order. The primary key is `(run_id, page_key)`, so a selector that
  // ordered by key would still look indexed and would still return a pending page -- just the wrong
  // one, and only visibly wrong when the two orders disagree.
  const migrated = migratedSqlite();
  await ensureCrawlFetchSession(migrated.db, {
    runId: "run-1",
    shopKey: "shop",
    requestedAt: AT,
    maxPages: 10,
    pageLimit: 10,
    pages: [{ key: "zzz-first", page: "zzz-first", ordinal: 0 }],
    createdAt: AT,
  });
  const insert = migrated.sqlite.prepare(`
    INSERT INTO crawl_fetch_pages (run_id, page_key, page_json, ordinal, state)
    VALUES ('run-1', ?, ?, ?, 'pending')
  `);
  insert.run("mmm-second", '"mmm-second"', 1);
  insert.run("aaa-third", '"aaa-third"', 2);

  const frontier = await crawlFetchFrontierProbe(migrated.db, "run-1", "zzz-first");

  assert.equal(
    frontier.nextPendingPageKey,
    "mmm-second",
    "ordinal 1 comes next even though another pending page sorts earlier by key",
  );
});

test("an empty run answers without a frontier to read", async () => {
  const migrated = migratedSqlite();
  await ensureCrawlFetchSession(migrated.db, {
    runId: "run-1",
    shopKey: "shop",
    requestedAt: AT,
    maxPages: 10,
    pageLimit: 10,
    pages: [],
    createdAt: AT,
  });

  const frontier = await crawlFetchFrontierProbe(migrated.db, "run-1");
  assert.equal(frontier.nextOrdinal, 0);
  assert.equal(frontier.hasStagedItems, false);
  assert.equal(frontier.nextPendingPageKey, null);
});

for (const cardinality of [100, 1_000, 10_000] as const) {
  test(`the frontier probe stays one bounded read at ${cardinality} pages`, async () => {
    const { sqlite, db } = await createSession(cardinality);
    // Make the first page no longer pending so the selector has to seek to the next pending ordinal,
    // and give it items so the staged probe has something to find.
    sqlite
      .prepare(
        "UPDATE crawl_fetch_pages SET state = 'parsed', item_count = 3 WHERE run_id = 'run-1' AND page_key = 'page-0'",
      )
      .run();
    const recording = recordingDatabase(db);

    const frontier = await crawlFetchFrontierProbe(recording.db, "run-1", "page-0");

    assert.equal(frontier.nextOrdinal, cardinality);
    assert.equal(frontier.hasStagedItems, true);
    assert.equal(frontier.nextPendingPageKey, "page-1");
    assert.equal(
      selects(recording.executed).length,
      1,
      "all three frontier facts cost one D1 statement, whatever the frontier's size",
    );
    assertNoGrowingTableScans(sqlite, recording.executed, {
      label: `${cardinality}-page frontier`,
    });
    assertNoSortBeforeLimit(sqlite, recording.executed, `${cardinality}-page frontier`);

    // Every subquery seeks; none walks the table. That is what keeps the read independent of P.
    const plan = queryPlan(sqlite, selects(recording.executed)[0]!);
    const touching = plan.filter((step) => /crawl_fetch_pages/u.test(step.detail));
    assert.equal(touching.length, 3, `expected three index probes:\n${describe(plan)}`);
    for (const step of touching) {
      assert.match(
        step.detail,
        /^SEARCH crawl_fetch_pages USING (?:COVERING )?INDEX/u,
        `a frontier probe stopped being a seek at ${cardinality} pages:\n${describe(plan)}`,
      );
    }
  });
}

function describe(plan: readonly { detail: string }[]): string {
  return plan.map((step) => step.detail).join("\n");
}

for (const cardinality of [100, 1_000, 10_000]) {
  test(`empty and late-hit frontiers seek only nonempty pages at ${cardinality} pages`, async () => {
    const { sqlite, db } = await createSession(cardinality);
    sqlite.exec("UPDATE crawl_fetch_pages SET state = 'parsed', item_count = 0");
    for (const hasItems of [false, true]) {
      if (hasItems) {
        sqlite
          .prepare("UPDATE crawl_fetch_pages SET item_count = 1 WHERE ordinal = ?")
          .run(cardinality - 1);
      }
      const recording = recordingDatabase(db);
      const frontier = await crawlFetchFrontierProbe(recording.db, "run-1");
      assert.equal(frontier.hasStagedItems, hasItems);
      assert.equal(frontier.nextOrdinal, cardinality);
      assert.equal(frontier.nextPendingPageKey, null);
      const plan = queryPlan(sqlite, recording.executed[0]!);
      assert.ok(
        plan.some((step) =>
          /SEARCH crawl_fetch_pages USING COVERING INDEX idx_crawl_fetch_pages_nonempty/.test(
            step.detail,
          ),
        ),
        `the staged-items lookup must exclude all empty pages:\n${describe(plan)}`,
      );
      assertNoGrowingTableScans(sqlite, recording.executed);
      assertNoSortBeforeLimit(sqlite, recording.executed);
    }
  });
}
