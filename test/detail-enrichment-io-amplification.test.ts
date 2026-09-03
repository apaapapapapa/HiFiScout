import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import {
  getCrawlFetchDetailPage,
  hasCrawlFetchDetailPage,
  recordCrawlFetchDetailPage,
} from "../src/db/crawl-fetch-detail-repository.js";
import { loadStagedCrawlProducts } from "../src/db/crawl-fetch-page-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { queryPlan, readsThroughIndex, recordingDatabase } from "./helpers/query-plan.js";

/**
 * The reads the detail-enrichment phase makes against D1, and what they are allowed to cost.
 *
 * Planning once per run bounded how *often* these run; it did not change what each one asks for.
 * The fence loaded a whole staged seller page to answer a yes/no question, and the planner loaded
 * the run's entire staging table -- every state, every column, HTML included -- to use the product
 * arrays of the parsed rows. Both are asserted here against the real migrated schema, because both
 * are properties of the SQL rather than of the caller.
 */

const RUN = "run-io-amplification";
const OTHER_RUN = "run-other";
const DETAIL_URL = "https://shop.test/detail/1";

/** The columns whose whole point is to carry a seller page; none belong in these reads. */
const PAYLOAD_COLUMNS = ["html_text", "products_json", "html_bytes"];

function seedSession(sqlite: DatabaseSync, runId: string): void {
  sqlite
    .prepare(`
      INSERT INTO crawl_fetch_sessions
        (run_id, shop_key, requested_at, status, max_pages, page_limit, created_at, updated_at)
      VALUES (?, 'shop', ?, 'collecting', 30, 30, ?, ?)
    `)
    .run(runId, `${runId}-requested`, "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
}

interface StagedPage {
  key: string;
  ordinal: number;
  state: "pending" | "fetched" | "parsed" | "ignored";
  products?: { sourceId: string; title: string }[];
  html?: string;
}

function seedPages(sqlite: DatabaseSync, runId: string, pages: readonly StagedPage[]): void {
  const insert = sqlite.prepare(`
    INSERT INTO crawl_fetch_pages
      (run_id, page_key, page_json, ordinal, state, html_text, products_json, html_bytes,
       item_count, fetched_at, parsed_at)
    VALUES (?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const page of pages) {
    const productsJson = page.products ? JSON.stringify(page.products) : null;
    const html = page.html ?? null;
    insert.run(
      runId,
      page.key,
      page.ordinal,
      page.state,
      html,
      productsJson,
      html ? html.length : 0,
      page.products?.length ?? 0,
      "2026-09-03T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    );
  }
}

test("the commit fence answers from the index without loading the staged page", async () => {
  // The fence asks one bit -- has this run already committed an attempt for this URL -- and used to
  // answer it by loading the staged detail page, seller HTML included, then discarding all of it.
  const { sqlite, db } = migratedSqlite();
  seedSession(sqlite, RUN);
  const recording = recordingDatabase(db);

  assert.equal(await hasCrawlFetchDetailPage(recording.db, RUN, DETAIL_URL), false);
  await recordCrawlFetchDetailPage(db, {
    runId: RUN,
    targetUrl: DETAIL_URL,
    html: "<html><body>a whole seller detail page</body></html>",
    fetchedAt: "2026-09-03T00:05:00.000Z",
  });
  assert.equal(await hasCrawlFetchDetailPage(recording.db, RUN, DETAIL_URL), true);

  assert.equal(recording.executed.length, 2, "one statement per fence check");
  for (const statement of recording.executed) {
    for (const column of PAYLOAD_COLUMNS) {
      assert.ok(
        !statement.sql.includes(column),
        `the fence must not select ${column}: ${statement.sql}`,
      );
    }
    assert.ok(!/SELECT\s+\*/iu.test(statement.sql), "the fence must not select every column");
    assert.ok(
      readsThroughIndex(
        queryPlan(sqlite, statement),
        "crawl_fetch_pages",
        "sqlite_autoindex_crawl_fetch_pages_1",
      ),
      "the fence must be answered by the (run_id, page_key) primary key",
    );
  }
});

test("the full detail read stays available for the caller that needs the response", async () => {
  // Narrowing the fence must not narrow finalization, which consumes the staged HTML itself.
  const { sqlite, db } = migratedSqlite();
  seedSession(sqlite, RUN);
  await recordCrawlFetchDetailPage(db, {
    runId: RUN,
    targetUrl: DETAIL_URL,
    html: "<html><body>evidence</body></html>",
    fetchedAt: "2026-09-03T00:05:00.000Z",
  });

  const staged = await getCrawlFetchDetailPage(db, RUN, DETAIL_URL);
  assert.equal(staged?.html_text, "<html><body>evidence</body></html>");
  assert.equal(staged?.fetched_at, "2026-09-03T00:05:00.000Z");
});

test("the fence is scoped to its own run", async () => {
  const { sqlite, db } = migratedSqlite();
  seedSession(sqlite, RUN);
  seedSession(sqlite, OTHER_RUN);
  await recordCrawlFetchDetailPage(db, {
    runId: OTHER_RUN,
    targetUrl: DETAIL_URL,
    html: "<html></html>",
    fetchedAt: "2026-09-03T00:05:00.000Z",
  });

  assert.equal(await hasCrawlFetchDetailPage(db, RUN, DETAIL_URL), false);
  assert.equal(await hasCrawlFetchDetailPage(db, OTHER_RUN, DETAIL_URL), true);
});

test("staged planning reads the parsed listings and nothing else in the run", async () => {
  const { sqlite, db } = migratedSqlite();
  seedSession(sqlite, RUN);
  seedPages(sqlite, RUN, [
    { key: "p1", ordinal: 0, state: "parsed", products: [{ sourceId: "a", title: "A" }] },
    // Fetched but not yet parsed: carries the listing HTML and no products.
    { key: "p2", ordinal: 1, state: "fetched", html: "<html>listing 2</html>" },
    { key: "p3", ordinal: 2, state: "parsed", products: [{ sourceId: "b", title: "B" }] },
    // Never fetched.
    { key: "p4", ordinal: 3, state: "pending" },
    // Coverage gave up on this one; `recordCrawlFetchPageIgnored` clears its payload.
    { key: "p5", ordinal: 4, state: "ignored" },
  ]);
  // A staged detail response: an `ignored` row that does carry HTML, and is not a listing page.
  await recordCrawlFetchDetailPage(db, {
    runId: RUN,
    targetUrl: DETAIL_URL,
    html: "<html>detail</html>",
    fetchedAt: "2026-09-03T00:05:00.000Z",
  });

  const recording = recordingDatabase(db);
  const products = await loadStagedCrawlProducts(recording.db, RUN);

  assert.deepEqual(
    products.map((product) => product.sourceId),
    ["a", "b"],
  );
  const [statement] = recording.executed;
  assert.ok(statement, "the loader issues a statement");
  assert.ok(!/SELECT\s+\*/iu.test(statement.sql), "the loader must not select every column");
  assert.ok(!statement.sql.includes("html_text"), "the loader must not read staged HTML");
  assert.match(statement.sql, /state\s*=\s*'parsed'/u, "the state filter belongs in the query");
  assert.ok(
    readsThroughIndex(
      queryPlan(sqlite, statement),
      "crawl_fetch_pages",
      "idx_crawl_fetch_pages_frontier",
    ),
    "(run_id, state, ordinal) already serves both the filter and the order",
  );
  assert.ok(
    !queryPlan(sqlite, statement).some((step) => /USE TEMP B-TREE/iu.test(step.detail)),
    "ordering by ordinal must not cost a temporary sort",
  );
});

test("a source id listed on two pages keeps the later page's copy", async () => {
  // Page order decides the dedupe, so the narrowed query has to preserve it.
  const { sqlite, db } = migratedSqlite();
  seedSession(sqlite, RUN);
  seedPages(sqlite, RUN, [
    { key: "p1", ordinal: 0, state: "parsed", products: [{ sourceId: "a", title: "first" }] },
    { key: "p2", ordinal: 1, state: "parsed", products: [{ sourceId: "a", title: "second" }] },
  ]);

  const products = await loadStagedCrawlProducts(db, RUN);
  assert.deepEqual(
    products.map((product) => product.title),
    ["second"],
  );
});

test("appending a detail row costs one index seek, not a walk of the run", async () => {
  // Measured rather than assumed: `MAX(ordinal)` over `UNIQUE (run_id, ordinal)` is SQLite's
  // MIN/MAX optimisation, a seek to the last entry. That is why the detail commit still allocates
  // its ordinal inline instead of reserving a base ordinal at plan time -- the cost does not grow
  // with the run's page count. This pins the premise: drop that index and the plan changes.
  const { sqlite, db } = migratedSqlite();
  seedSession(sqlite, RUN);
  seedPages(
    sqlite,
    RUN,
    Array.from({ length: 40 }, (_, index) => ({
      key: `p${index}`,
      ordinal: index,
      state: "parsed" as const,
      products: [{ sourceId: `s${index}`, title: `T${index}` }],
    })),
  );

  const recording = recordingDatabase(db);
  await recordCrawlFetchDetailPage(recording.db, {
    runId: RUN,
    targetUrl: DETAIL_URL,
    html: "<html></html>",
    fetchedAt: "2026-09-03T00:05:00.000Z",
  });

  const [commit] = recording.executed;
  assert.ok(commit, "the commit issues a statement");
  const plan = queryPlan(sqlite, commit);
  assert.ok(
    readsThroughIndex(plan, "crawl_fetch_pages", "sqlite_autoindex_crawl_fetch_pages_2"),
    `ordinal allocation must use the (run_id, ordinal) index: ${JSON.stringify(plan)}`,
  );

  const ordinal = sqlite
    .prepare("SELECT ordinal FROM crawl_fetch_pages WHERE run_id = ? AND state = 'ignored'")
    .get(RUN) as { ordinal: number };
  assert.equal(ordinal.ordinal, 40, "the detail row lands after the listing frontier");
});
