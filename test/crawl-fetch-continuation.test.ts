import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  claimCrawlFetchFinalization,
  completeCrawlFetchSession,
  ensureCrawlFetchSession,
  getCrawlFetchSession,
  listCrawlFetchPages,
} from "../src/db/crawl-fetch-session-repository.js";
import {
  recordCrawlFetchPageFetched,
  recordCrawlFetchPageParsed,
} from "../src/db/crawl-fetch-page-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const REQUESTED_AT = "2026-08-29T00:00:00.000Z";

function syntheticPages(count: number) {
  return Array.from({ length: count }, (_, ordinal) => ({
    key: `https://example.test/used?page=${ordinal + 1}`,
    page: `https://example.test/used?page=${ordinal + 1}`,
    ordinal,
  }));
}

test("a first-run dynamically discovered 50-page collection stays bounded by page continuations", async () => {
  const { db } = migratedSqlite();
  const pages = syntheticPages(50);
  const firstPage = pages[0];
  assert.ok(firstPage);
  const runId = "synthetic:first-run-dynamic-50-pages";

  // Model a first run with no historical workload observation: only the seed page is
  // known up front. Every later page is discovered by parsing the previous page.
  await ensureCrawlFetchSession(db, {
    runId,
    shopKey: "synthetic",
    requestedAt: REQUESTED_AT,
    maxPages: 50,
    pageLimit: 50,
    pages: [firstPage],
    createdAt: REQUESTED_AT,
  });

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const nextPage = pages[index + 1];
    assert.ok(page);

    let session = await getCrawlFetchSession(db, runId);
    assert.ok(session);
    assert.equal(session.next_phase, "fetch");
    assert.equal(session.next_page_key, page.key);
    assert.equal(session.continuation_sequence, index * 2);

    // Before this invocation only pages discovered so far are durable. The entire
    // unexpectedly large frontier is never materialized or processed in one unit.
    let storedPages = await listCrawlFetchPages(db, runId);
    assert.equal(storedPages.length, index + 1);

    await recordCrawlFetchPageFetched(db, {
      runId,
      pageKey: page.key,
      html: `<html><body>page ${index + 1}</body></html>`,
      htmlBytes: 38,
      fetchedAt: REQUESTED_AT,
      currentSequence: session.continuation_sequence,
    });

    session = await getCrawlFetchSession(db, runId);
    assert.ok(session);
    assert.equal(session.next_phase, "parse");
    assert.equal(session.next_page_key, page.key);
    assert.equal(session.continuation_sequence, index * 2 + 1);

    await recordCrawlFetchPageParsed(db, {
      runId,
      pageKey: page.key,
      products: [],
      discoveredPages: nextPage ? [nextPage] : [],
      parsedAt: REQUESTED_AT,
      currentSequence: session.continuation_sequence,
      nextPageKey: nextPage?.key || null,
      coverageIncomplete: false,
      reachedEnd: false,
    });

    session = await getCrawlFetchSession(db, runId);
    assert.ok(session);
    assert.equal(session.continuation_sequence, (index + 1) * 2);
    if (nextPage) {
      assert.equal(session.next_phase, "fetch");
      assert.equal(session.next_page_key, nextPage.key);
    } else {
      assert.equal(session.next_phase, "finalize");
      assert.equal(session.next_page_key, null);
    }

    storedPages = await listCrawlFetchPages(db, runId);
    assert.equal(storedPages.length, Math.min(index + 2, pages.length));
    assert.equal(storedPages.filter((candidate) => candidate.state === "parsed").length, index + 1);
  }

  const session = await getCrawlFetchSession(db, runId);
  assert.ok(session);
  assert.equal(session.pages_fetched, 50);
  assert.equal(session.pages_parsed, 50);
  assert.equal(session.continuation_sequence, 100);
  assert.equal(session.next_phase, "finalize");
  assert.equal(session.next_page_key, null);

  const storedPages = await listCrawlFetchPages(db, runId);
  assert.equal(storedPages.length, 50);
  assert.ok(storedPages.every((page) => page.state === "parsed"));
});

test("duplicate continuation writes do not advance a page or session twice", async () => {
  const { db } = migratedSqlite();
  const [page] = syntheticPages(1);
  assert.ok(page);
  const runId = "synthetic:duplicate";

  await ensureCrawlFetchSession(db, {
    runId,
    shopKey: "synthetic",
    requestedAt: REQUESTED_AT,
    maxPages: 1,
    pageLimit: 1,
    pages: [page],
    createdAt: REQUESTED_AT,
  });

  await recordCrawlFetchPageFetched(db, {
    runId,
    pageKey: page.key,
    html: "<html></html>",
    htmlBytes: 13,
    fetchedAt: REQUESTED_AT,
    currentSequence: 0,
  });
  await recordCrawlFetchPageFetched(db, {
    runId,
    pageKey: page.key,
    html: "<html>duplicate</html>",
    htmlBytes: 22,
    fetchedAt: REQUESTED_AT,
    currentSequence: 0,
  });

  let session = await getCrawlFetchSession(db, runId);
  assert.ok(session);
  assert.equal(session.pages_fetched, 1);
  assert.equal(session.continuation_sequence, 1);

  await recordCrawlFetchPageParsed(db, {
    runId,
    pageKey: page.key,
    products: [],
    discoveredPages: [],
    parsedAt: REQUESTED_AT,
    currentSequence: 1,
    nextPageKey: null,
    coverageIncomplete: false,
    reachedEnd: false,
  });
  await recordCrawlFetchPageParsed(db, {
    runId,
    pageKey: page.key,
    products: [],
    discoveredPages: [],
    parsedAt: REQUESTED_AT,
    currentSequence: 1,
    nextPageKey: null,
    coverageIncomplete: false,
    reachedEnd: false,
  });

  session = await getCrawlFetchSession(db, runId);
  assert.ok(session);
  assert.equal(session.pages_parsed, 1);
  assert.equal(session.continuation_sequence, 2);
  assert.equal(session.next_phase, "finalize");
});

test("finalization is single-flight for duplicate deliveries", async () => {
  const { db } = migratedSqlite();
  const runId = "synthetic:finalize";

  await ensureCrawlFetchSession(db, {
    runId,
    shopKey: "synthetic",
    requestedAt: REQUESTED_AT,
    maxPages: 0,
    pageLimit: 0,
    pages: [],
    createdAt: REQUESTED_AT,
  });

  const firstClaim = await claimCrawlFetchFinalization(
    db,
    runId,
    "2026-08-29T00:01:00.000Z",
    "2026-08-28T23:59:00.000Z",
  );
  const duplicateClaim = await claimCrawlFetchFinalization(
    db,
    runId,
    "2026-08-29T00:01:01.000Z",
    "2026-08-28T23:59:01.000Z",
  );
  assert.equal(firstClaim, true);
  assert.equal(duplicateClaim, false);

  await completeCrawlFetchSession(db, {
    runId,
    finalizedAt: "2026-08-29T00:01:02.000Z",
    crawlRunId: 42,
  });
  const afterCompletion = await claimCrawlFetchFinalization(
    db,
    runId,
    "2026-08-29T00:02:00.000Z",
    "2026-08-29T00:01:59.000Z",
  );
  assert.equal(afterCompletion, false);
});

test("staging a partial collection never mutates existing listing activity or price history", async () => {
  const { db, sqlite } = migratedSqlite();
  sqlite.exec(`
    INSERT INTO products (
      shop_key, source_id, manufacturer, model, title, category, condition_text,
      price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at, is_active
    ) VALUES (
      'synthetic', 'existing', 'Example', 'A1', 'Existing listing', 'その他', '',
      100000, 'in_stock', 'https://example.test/existing',
      '${REQUESTED_AT}', '${REQUESTED_AT}', '${REQUESTED_AT}', 1
    );
    INSERT INTO price_history (product_id, price_yen, observed_at)
    SELECT id, 100000, '${REQUESTED_AT}' FROM products WHERE source_id = 'existing';
  `);

  const [page] = syntheticPages(1);
  assert.ok(page);
  await ensureCrawlFetchSession(db, {
    runId: "synthetic:partial",
    shopKey: "synthetic",
    requestedAt: REQUESTED_AT,
    maxPages: 1,
    pageLimit: 1,
    pages: [page],
    createdAt: REQUESTED_AT,
  });
  await recordCrawlFetchPageFetched(db, {
    runId: "synthetic:partial",
    pageKey: page.key,
    html: "<html>partial</html>",
    htmlBytes: 20,
    fetchedAt: REQUESTED_AT,
    currentSequence: 0,
  });

  const listing = sqlite
    .prepare("SELECT is_active, price_yen FROM products WHERE source_id = 'existing'")
    .get() as { is_active: number; price_yen: number };
  const history = sqlite.prepare("SELECT COUNT(*) AS count FROM price_history").get() as {
    count: number;
  };
  assert.equal(listing.is_active, 1);
  assert.equal(listing.price_yen, 100000);
  assert.equal(history.count, 1);
});
