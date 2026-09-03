import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { processFetch, processParse } from "../src/crawler/resumable-page-steps.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import type {
  ResumableCrawlQueueMessage,
  ResumableRuntimeEnv,
} from "../src/crawler/resumable-queue-contract.js";
import {
  ensureCrawlFetchSession,
  getCrawlFetchSession,
  listCrawlFetchPages,
} from "../src/db/crawl-fetch-session-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  assertNoGrowingTableScans,
  assertNoSortBeforeLimit,
  recordingDatabase,
  selects,
} from "./helpers/query-plan.js";
import type { ExecutedStatement } from "./helpers/query-plan.js";

/**
 * What one bounded crawl step costs D1.
 *
 * The durability is the point of the design and is not up for reduction: every step commits its
 * page result and advances the session in one batch, and the next step resumes from that. What was
 * not the point is how the step *read* to get there. Deciding which page comes next needs four
 * facts about the run's pages -- the keys already known, the highest ordinal, the next pending page,
 * and the items staged so far -- and the step used to gather them with `SELECT *` over every page of
 * the run, so parsing page N re-read the products of pages 1..N-1. Payload grew with the square of
 * the page count while the facts extracted from it stayed four numbers.
 *
 * These tests pin the shape of a step: what it reads, how many times it talks to D1, and that the
 * commit still precedes the cursor.
 */

const REQUESTED_AT = "2026-09-03T00:00:00.000Z";

const loadedPlugin = getShopPlugin("home-shokai");
if (!loadedPlugin) throw new Error("home-shokai plugin missing");
const plugin = loadedPlugin;

/** A listing page carrying real items, so parsing writes something worth resuming from. */
function listingHtml(page: number): string {
  const items = Array.from(
    { length: 20 },
    (_, index) =>
      `<a href="/item.php?z=P${page}I${index}">LUXMAN プリメインアンプ L-${page}${index} 中古 ¥250,000</a>`,
  );
  return `<html><body>${items.join("")}</body></html>`;
}

interface Harness {
  env: ResumableRuntimeEnv;
  body: ResumableCrawlQueueMessage;
  runId: string;
  inner: ReturnType<typeof migratedSqlite>["db"];
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"];
  executed: ExecutedStatement[];
}

async function harness(pageCount: number): Promise<Harness> {
  const { sqlite, db: inner } = migratedSqlite();
  const recording = recordingDatabase(inner);
  const runId = `roundtrips:${pageCount}`;
  await ensureCrawlFetchSession(inner, {
    runId,
    shopKey: plugin.key,
    requestedAt: REQUESTED_AT,
    maxPages: pageCount,
    pageLimit: pageCount,
    pages: Array.from({ length: pageCount }, (_, ordinal) => ({
      key: `https://www.homeshokai.com/list.php?a=${ordinal + 2}`,
      page: `https://www.homeshokai.com/list.php?a=${ordinal + 2}`,
      ordinal,
    })),
    createdAt: REQUESTED_AT,
  });
  return {
    sqlite,
    inner,
    executed: recording.executed,
    env: {
      DB: recording.db,
      HOME_SHOKAI_REQUEST_DELAY_MS: "0",
    } as unknown as ResumableRuntimeEnv,
    body: {
      shopKey: plugin.key,
      requestedAt: REQUESTED_AT,
      collectionRunId: runId,
    } as unknown as ResumableCrawlQueueMessage,
    runId,
  };
}

/** The first line of each statement a step issued, in order. */
function statementLines(executed: readonly ExecutedStatement[]): string[] {
  return executed.map((statement) => statement.sql.trim().split("\n")[0]!.trim());
}

async function step(
  held: Harness,
  stage: "fetch" | "parse",
  page: number,
): Promise<{ statements: string[] }> {
  const session = await getCrawlFetchSession(held.inner, held.runId);
  assert.ok(session, "the run should still have a session");
  assert.equal(session.next_phase, stage);
  held.executed.length = 0;
  const run = stage === "fetch" ? processFetch : processParse;
  await run(held.env, plugin, session, held.body, {
    fetchHtmlPage: async () => listingHtml(page),
  });
  return { statements: statementLines(held.executed) };
}

test("a parse step reads the frontier once instead of the whole run twice", async () => {
  const held = await harness(4);
  await step(held, "fetch", 0);

  const { statements } = await step(held, "parse", 0);

  // The page being parsed, the frontier, the two writes of the one batched commit, then the session
  // the continuation is built from. No second aggregate, and no `SELECT *` over the run.
  assert.deepEqual(statements.length, 5, `unexpected statements:\n${statements.join("\n")}`);
  assert.ok(
    !statements.some((sql) =>
      /SELECT \* FROM crawl_fetch_pages WHERE run_id = \? ORDER BY/u.test(sql),
    ),
    `a parse step must not read every column of every page:\n${statements.join("\n")}`,
  );
  assert.ok(
    statements.some((sql) => /SELECT page_key, ordinal, state, item_count/u.test(sql)),
    `the frontier read should be the narrow one:\n${statements.join("\n")}`,
  );
  assert.ok(
    !statements.some((sql) => /COALESCE\(SUM\(item_count\)/u.test(sql)),
    `the staged item count comes from the frontier now:\n${statements.join("\n")}`,
  );
});

test("a step's D1 traffic does not grow with the pages already behind it", async () => {
  const held = await harness(6);
  const perStep: number[] = [];

  for (let page = 0; page < 5; page += 1) {
    await step(held, "fetch", page);
    perStep.push((await step(held, "parse", page)).statements.length);
  }

  assert.deepEqual(
    perStep,
    [5, 5, 5, 5, 5],
    "each step costs the same however far the run has got",
  );
});

test("every statement a step issues reads through an index", async () => {
  const held = await harness(3);
  await step(held, "fetch", 0);
  await step(held, "parse", 0);

  assertNoGrowingTableScans(held.sqlite, held.executed, { label: "parse step" });
  assertNoSortBeforeLimit(held.sqlite, held.executed, "parse step");
  assert.ok(selects(held.executed).length > 0);
});

test("the page result is committed before the cursor moves off it", async () => {
  // The invariant the batching rests on. Both writes are in one batch, so there is no window where
  // the session points past a page whose products were never stored -- but the order within the
  // batch is what a reader of this code checks, and a reordering would be silent otherwise.
  const held = await harness(2);
  await step(held, "fetch", 0);
  const { statements } = await step(held, "parse", 0);

  const pageWrite = statements.findIndex((sql) => sql.startsWith("UPDATE crawl_fetch_pages"));
  const sessionWrite = statements.findIndex((sql) => sql.startsWith("UPDATE crawl_fetch_sessions"));
  assert.ok(pageWrite >= 0 && sessionWrite >= 0, `expected both writes:\n${statements.join("\n")}`);
  assert.ok(
    pageWrite < sessionWrite,
    `the page result must be written before the session advances:\n${statements.join("\n")}`,
  );
});

test("a step replayed after its commit does not stage the page twice", async () => {
  // Redelivery: the batch landed, the caller never learned. The page is no longer `fetched`, so the
  // replayed step returns without parsing again, and the run's staged items are unchanged.
  const held = await harness(3);
  await step(held, "fetch", 0);
  const session = await getCrawlFetchSession(held.inner, held.runId);
  assert.ok(session);
  await processParse(held.env, plugin, session, held.body, {
    fetchHtmlPage: async () => listingHtml(0),
  });

  const afterFirst = await listCrawlFetchPages(held.inner, held.runId);
  const parsedOnce = afterFirst.filter((page) => page.state === "parsed");
  assert.equal(parsedOnce.length, 1);
  const staged = parsedOnce[0]?.products_json;

  // The same message again, with the session row the first delivery started from.
  await processParse(held.env, plugin, session, held.body, {
    fetchHtmlPage: async () => listingHtml(0),
  });

  const afterReplay = await listCrawlFetchPages(held.inner, held.runId);
  assert.equal(afterReplay.filter((page) => page.state === "parsed").length, 1);
  assert.equal(afterReplay.find((page) => page.state === "parsed")?.products_json, staged);
  assert.equal(
    afterReplay.length,
    afterFirst.length,
    "a replayed parse must not discover its pages a second time",
  );
});

test("a step killed before its commit leaves the page ready to run again", async () => {
  // The hard-kill case: the fetch happened, the batch did not. Nothing durable moved, so the next
  // delivery does the same work rather than skipping it.
  const held = await harness(3);
  await step(held, "fetch", 0);
  const before = await getCrawlFetchSession(held.inner, held.runId);
  assert.ok(before);
  assert.equal(before.next_phase, "parse");

  const killed = { ...held.env, DB: { ...held.env.DB } } as ResumableRuntimeEnv;
  killed.DB = new Proxy(held.env.DB, {
    get(target, property) {
      if (property !== "batch") return Reflect.get(target, property);
      return async () => {
        throw new Error("isolate killed before the commit landed");
      };
    },
  });

  await assert.rejects(
    processParse(killed, plugin, before, held.body, { fetchHtmlPage: async () => listingHtml(0) }),
    /isolate killed/u,
  );

  const after = await getCrawlFetchSession(held.inner, held.runId);
  assert.equal(after?.next_phase, "parse", "the cursor did not move past the uncommitted page");
  assert.equal(after?.next_page_key, before.next_page_key);
  assert.equal(after?.continuation_sequence, before.continuation_sequence);
  const pages = await listCrawlFetchPages(held.inner, held.runId);
  assert.equal(pages.filter((page) => page.state === "parsed").length, 0);

  // And the retry succeeds, from exactly where it was.
  const recovered = await step(held, "parse", 0);
  assert.ok(recovered.statements.length > 0);
  const settled = await listCrawlFetchPages(held.inner, held.runId);
  assert.equal(settled.filter((page) => page.state === "parsed").length, 1);
});
