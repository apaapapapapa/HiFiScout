import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { getCrawlerSettings } from "../src/config.js";
import {
  finishCrawlRunFailure,
  finishCrawlRunSuccess,
  recordCrawlRunProgress,
} from "../src/db/crawl-run-repository.js";
import { DERIVED_WORK_BUDGET_MS } from "../src/crawler/crawl-continuation.js";
import { crawlShop } from "../src/crawler/run.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import {
  createInvocationDeadline,
  DeadlineExceededError,
  isDeadlineExceeded,
} from "../src/deadline.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { asQueryableDatabase } from "./helpers/d1.js";

/** Cloudflare's wall-clock limit for one Queue consumer invocation. */
const QUEUE_INVOCATION_LIMIT_MS = 15 * 60_000;

const never = <T>(): Promise<T> => new Promise<T>(() => {});

test("a guarded call that never settles rejects instead of blocking", async () => {
  const deadline = createInvocationDeadline(30);

  await assert.rejects(
    deadline.guard("d1_write", never),
    (error: unknown) =>
      isDeadlineExceeded(error) && error.label === "d1_write" && error.budgetMs === 30,
  );
  // This is the whole point: control is back, inside the same invocation, with a catchable error.
  assert.ok(deadline.expired());
});

test("a guarded call that finishes in time passes its value through", async () => {
  const deadline = createInvocationDeadline(60_000);
  assert.equal(await deadline.guard("d1_read", async () => 42), 42);
  assert.equal(deadline.expired(), false);
});

test("a guarded call reports its own failure rather than the deadline's", async () => {
  const deadline = createInvocationDeadline(60_000);
  await assert.rejects(
    deadline.guard("d1_write", async () => {
      throw new Error("D1 unavailable");
    }),
    (error: unknown) => error instanceof Error && error.message === "D1 unavailable",
  );
});

test("a synchronous throw inside a guard arrives as a rejection", async () => {
  const deadline = createInvocationDeadline(60_000);
  await assert.rejects(
    deadline.guard("d1_write", () => {
      throw new Error("bad statement");
    }),
    (error: unknown) => error instanceof Error && error.message === "bad statement",
  );
});

test("check stops a loop once the budget is spent", async () => {
  const deadline = createInvocationDeadline(10, Date.now() - 1_000);
  assert.throws(() => deadline.check("collection"), DeadlineExceededError);
  assert.equal(deadline.remainingMs(), 0);

  const fresh = createInvocationDeadline(60_000);
  assert.doesNotThrow(() => fresh.check("collection"));
});

test("an expired budget rejects a guard without starting the work", async () => {
  const deadline = createInvocationDeadline(10, Date.now() - 1_000);
  let started = false;
  await assert.rejects(
    deadline.guard("d1_write", async () => {
      started = true;
    }),
    DeadlineExceededError,
  );
  assert.equal(started, false, "an over-budget invocation must not start another binding call");
});

test("the crawl budgets nest inside one another and inside the platform limit", () => {
  const settings = getCrawlerSettings(undefined);

  // Collection has to give up first: it is the stage that can spend minutes with nothing durable to
  // show for it. Derived work stops next, but gracefully — it defers to the continuation sweep
  // rather than failing — so the invocation bound has to sit above it or it would convert an
  // ordinary deferral into a failure.
  assert.ok(settings.collectionBudgetMs <= DERIVED_WORK_BUDGET_MS);
  assert.ok(DERIVED_WORK_BUDGET_MS <= settings.invocationBudgetMs);

  // Two terminal phases can run after the work budget is spent: diagnostics, then the record. Both
  // have to fit before the platform kills the invocation, or the outcome is lost anyway.
  assert.ok(
    settings.invocationBudgetMs + 2 * settings.terminalBudgetMs < QUEUE_INVOCATION_LIMIT_MS,
    "the whole invocation must finish inside Cloudflare's limit with room to record its outcome",
  );
});

test("a seller that stops answering is recorded as a failure, not abandoned", async () => {
  const { sqlite, db } = migratedSqlite();
  const plugin = getShopPlugin("home-shokai");
  assert.ok(plugin);
  const env = {
    DB: db,
    CRAWL_COLLECTION_BUDGET_MS: "40",
    CRAWL_INVOCATION_BUDGET_MS: "30000",
    CRAWL_TERMINAL_BUDGET_MS: "30000",
  } as unknown as Parameters<typeof crawlShop>[0];

  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  let result;
  try {
    result = await crawlShop(env, plugin, {
      force: true,
      now: new Date("2026-08-25T12:00:00.000Z"),
      // The shape the production incident takes: a request that neither answers nor fails.
      fetchFn: never,
    });
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }

  assert.equal(result.status, "failed");
  const run = sqlite
    .prepare("SELECT status, message, current_stage, pages_done FROM crawl_runs WHERE shop_key = ?")
    .get("home-shokai") as {
    status: string;
    message: string;
    current_stage: string;
    pages_done: number;
  };
  // Without the budget this run stays `running` until a sweep closes it 25 minutes later with no
  // idea where it stopped. With it, the row says so itself.
  assert.equal(run.status, "failed");
  assert.match(run.message, /^fetch_parse: seller_page exceeded/u);
  assert.equal(run.current_stage, "fetch_parse");
  assert.equal(run.pages_done, 0);

  const state = sqlite
    .prepare("SELECT last_error_at, consecutive_failures FROM shop_sync_state WHERE shop_key = ?")
    .get("home-shokai") as { last_error_at: string | null; consecutive_failures: number };
  assert.ok(state.last_error_at);
  assert.equal(state.consecutive_failures, 1);
});

test("a heartbeat that lands after the run finished cannot reopen it", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = Number(
    sqlite
      .prepare("INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, 'running')")
      .run("ippinkan", "2026-08-25T11:00:00.000Z").lastInsertRowid,
  );
  await recordCrawlRunProgress(db, runId, {
    stage: "fetch_parse",
    pagesDone: 4,
    observedAt: "2026-08-25T11:01:00.000Z",
  });
  sqlite.prepare("UPDATE crawl_runs SET status = 'failed' WHERE id = ?").run(runId);

  // A guarded call is not cancelled when the caller stops waiting for it, so this is the arrival
  // the `status = 'running'` predicate exists for.
  await recordCrawlRunProgress(db, runId, {
    stage: "listing_write",
    pagesDone: 99,
    observedAt: "2026-08-25T11:20:00.000Z",
  });

  const row = sqlite
    .prepare("SELECT status, current_stage, pages_done FROM crawl_runs WHERE id = ?")
    .get(runId) as { status: string; current_stage: string; pages_done: number };
  assert.equal(row.status, "failed");
  assert.equal(row.current_stage, "fetch_parse");
  assert.equal(row.pages_done, 4);
});

test("a terminal write that lands late cannot overwrite the outcome already recorded", async () => {
  const { sqlite, db } = migratedSqlite();
  const runId = Number(
    sqlite
      .prepare("INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, 'running')")
      .run("ippinkan", "2026-08-25T11:00:00.000Z").lastInsertRowid,
  );

  await finishCrawlRunFailure(db, runId, {
    finishedAt: "2026-08-25T11:05:00.000Z",
    pageCount: 3,
    message: "collection stalled",
  });
  // A guarded write is not cancelled when its caller stops waiting, so the success write the crawl
  // gave up on can still arrive after the failure was recorded. First outcome wins.
  await finishCrawlRunSuccess(db, runId, {
    finishedAt: "2026-08-25T11:20:00.000Z",
    itemCount: 745,
    pageCount: 17,
    message: "745 items",
  });

  const row = sqlite
    .prepare("SELECT status, message, page_count FROM crawl_runs WHERE id = ?")
    .get(runId) as { status: string; message: string; page_count: number };
  assert.equal(row.status, "failed");
  assert.equal(row.message, "collection stalled");
  assert.equal(row.page_count, 3);
});

const HOME_SHOKAI_LISTINGS: Readonly<Record<string, string>> = {
  "a=2":
    '<a href="/item.php?z=CONSIGN1">LUXMAN プリメインアンプ L-507uXII 委託販売品 \u00a5250,000</a>',
  "a=3": '<a href="/item.php?z=SPECIAL1">ACCUPHASE プリアンプ C-2900 特価品 \u00a5980,000</a>',
};

/** Answers robots.txt and both Home Shokai listing pages, so the crawl reaches its success path. */
async function homeShokaiSeller(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.endsWith("/robots.txt")) return new Response("not found", { status: 404 });
  const listing = Object.entries(HOME_SHOKAI_LISTINGS).find(([query]) => url.includes(query))?.[1];
  return new Response(`<html><body>${listing ?? ""}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

test("a stalled bookkeeping write does not turn a successful crawl into a failed shop", async () => {
  const { sqlite, db } = migratedSqlite();
  const plugin = getShopPlugin("home-shokai");
  assert.ok(plugin);
  // `markShopSuccess` never settles, standing in for a D1 write that stops answering once the
  // listings are already durable.
  const stalling = asQueryableDatabase({
    prepare(sql: string) {
      if (/INSERT INTO shop_sync_state[\s\S]*last_success_at/u.test(sql)) {
        return { bind: () => ({ run: never, all: never, first: never }) };
      }
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  });
  const env = {
    DB: stalling,
    HOME_SHOKAI_REQUEST_DELAY_MS: "0",
    CRAWL_TERMINAL_BUDGET_MS: "50",
  } as unknown as Parameters<typeof crawlShop>[0];

  const originalWarn = console.warn;
  const originalLog = console.log;
  const warnings: string[] = [];
  console.warn = (line: string) => warnings.push(line);
  console.log = () => {};
  let result;
  try {
    result = await crawlShop(env, plugin, {
      force: true,
      now: new Date("2026-08-25T12:00:00.000Z"),
      fetchFn: homeShokaiSeller as unknown as typeof fetch,
    });
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }

  assert.equal(result.status, "success", "the collection itself succeeded");
  assert.equal(result.status === "success" && result.itemCount, 2);

  // The crawl keeps its own outcome. Raising the stalled write into the catch block would record a
  // failure and apply backoff, and the write still in flight would then land `markShopSuccess` on
  // top of it — leaving shop health contradicting the run row.
  const state = sqlite
    .prepare("SELECT last_error_at, consecutive_failures FROM shop_sync_state WHERE shop_key = ?")
    .get("home-shokai") as { last_error_at: string | null; consecutive_failures: number };
  assert.equal(state.last_error_at, null, "a successful crawl never records a shop failure");
  assert.equal(state.consecutive_failures, 0);

  const run = sqlite
    .prepare("SELECT status FROM crawl_runs WHERE shop_key = ?")
    .get("home-shokai") as { status: string };
  assert.equal(run.status, "success");

  const timeout = warnings
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.event === "crawl_terminal_write_timeout");
  assert.equal(
    timeout?.phase,
    "crawl_success_record",
    "the stalled write is reported as what it is",
  );
});

test("a stalled evidence archive costs a snapshot, not the crawl", async () => {
  const { sqlite, db } = migratedSqlite();
  const plugin = getShopPlugin("home-shokai");
  assert.ok(plugin);
  // A drop of more than 20% asks for an `unexpected_item_count` snapshot, but stays under the 50%
  // guard, so the crawl reaches the success-path evidence call rather than failing on coverage.
  sqlite
    .prepare("INSERT INTO shop_sync_state (shop_key, last_item_count) VALUES (?, 3)")
    .run("home-shokai");

  const env = {
    DB: db,
    // R2 never answers: the stall this whole change exists to survive, in the one place on the
    // success path that used to sit between two recorded stages with nothing bounding it.
    EVIDENCE_BUCKET: { put: never, head: never, get: never },
    HOME_SHOKAI_REQUEST_DELAY_MS: "0",
    CRAWL_TERMINAL_BUDGET_MS: "60",
  } as unknown as Parameters<typeof crawlShop>[0];

  const originalWarn = console.warn;
  const originalLog = console.log;
  const warnings: string[] = [];
  console.warn = (line: string) => warnings.push(line);
  console.log = () => {};
  let result;
  try {
    result = await crawlShop(env, plugin, {
      force: true,
      now: new Date("2026-08-25T12:00:00.000Z"),
      fetchFn: homeShokaiSeller as unknown as typeof fetch,
    });
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }

  // The listing write and every derived stage run after the snapshot, so the evidence bound has to
  // be a slice of its own: given the crawl's remaining budget it would have spent all of it.
  assert.equal(result.status, "success");
  assert.equal(result.status === "success" && result.itemCount, 2);
  const run = sqlite
    .prepare("SELECT status FROM crawl_runs WHERE shop_key = ?")
    .get("home-shokai") as { status: string };
  assert.equal(run.status, "success");
  assert.ok(
    warnings.some((line) => JSON.parse(line).event === "crawl_evidence_archive_failure"),
    "the snapshot that could not be stored is reported",
  );
});
