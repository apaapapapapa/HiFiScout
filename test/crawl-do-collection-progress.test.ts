import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { CrawlScheduler } from "../src/crawler/crawl-scheduler-do.js";
import { getCrawlerSettings } from "../src/config.js";
import {
  readCollectionSession,
  withCollectionProgress,
  type CollectionProgressState,
} from "../src/crawler/collection-progress.js";
import { processFetch, processParse } from "../src/crawler/resumable-page-steps.js";
import {
  continuationFromSession,
  type ResumableRuntimeEnv,
} from "../src/crawler/resumable-queue-contract.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { collectionProgress } from "../src/db/crawl-fetch-progress.js";
import {
  claimCrawlFetchFinalization,
  ensureCrawlFetchSession,
  getCrawlFetchSession,
  listCrawlFetchPages,
} from "../src/db/crawl-fetch-session-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { recordingDatabase } from "./helpers/query-plan.js";

const AT = "2026-09-05T00:00:00.000Z";
const RUN = "crawl:home-shokai:do-progress";
const STORAGE_KEY = "phase2_crawl_execution"; // Public DO record name, not a credential. gitleaks:allow
const plugin = getShopPlugin("home-shokai")!;
const HTML =
  '<html><body><a href="/item.php?z=1001">LUXMAN プリメインアンプ L-505 〇委託販売品 ￥250,000 -</a></body></html>';

async function harness(mode: "d1" | "durable_object" = "durable_object", count = 3) {
  const { db, sqlite } = migratedSqlite();
  const recording = recordingDatabase(db);
  const env = {
    DB: recording.db,
    HOME_SHOKAI_REQUEST_DELAY_MS: "0",
  } as unknown as ResumableRuntimeEnv;
  const body = {
    shopKey: plugin.key,
    force: true,
    requestedAt: AT,
    jobId: RUN,
    collectionRunId: RUN,
  };
  const { session } = await ensureCrawlFetchSession(db, {
    runId: RUN,
    shopKey: plugin.key,
    requestedAt: AT,
    createdAt: AT,
    progressStorage: mode,
    maxPages: count,
    pageLimit: count,
    pages: Array.from({ length: count }, (_, ordinal) => ({
      key: `https://www.homeshokai.jp/itemlist.php?a=${ordinal + 2}`,
      page: `https://www.homeshokai.jp/itemlist.php?a=${ordinal + 2}`,
      ordinal,
    })),
  });
  const state: CollectionProgressState = {
    value: { runId: RUN, progress: collectionProgress(session) },
  };
  const current = async () => {
    const row = await readCollectionSession(db, RUN, mode === "durable_object" ? state : undefined);
    assert.ok(row);
    return row;
  };
  const options = {
    ...(mode === "durable_object" ? { collectionProgress: state } : {}),
    fetchHtmlPage: async () => HTML,
  };
  return { db, sqlite, env, body, state, current, options, executed: recording.executed };
}

test("DO progress replays committed fetch and parse receipts without HTTP, parsing or writes", async () => {
  const h = await harness();
  for (const phase of ["fetch", "parse"] as const) {
    const session = await h.current();
    const before = structuredClone(h.state.value);
    const run = phase === "fetch" ? processFetch : processParse;
    const result = await run(h.env, plugin, session, h.body, h.options);
    const committed = structuredClone(h.state.value);
    h.state.value = before; // D1 committed; the Alarm died before the DO write.
    h.executed.length = 0;
    const forbidden = {
      ...plugin,
      parseWithStages() {
        throw new Error("duplicate parse");
      },
    };
    const replay = await run(h.env, forbidden, session, h.body, {
      collectionProgress: h.state,
      fetchHtmlPage: async () => {
        throw new Error("duplicate HTTP");
      },
    });
    assert.deepEqual(replay, result);
    assert.deepEqual(h.state.value, committed);
    assert.ok(
      h.executed.every(({ sql }) => /^\s*SELECT\b/u.test(sql)),
      "receipt replay only reads",
    );
    assert.equal((await getCrawlFetchSession(h.db, RUN))?.continuation_sequence, 0);
  }
  const pages = await listCrawlFetchPages(h.db, RUN);
  assert.equal(pages[0]?.html_text, null);
  assert.equal(pages[0]?.item_count, 1);
  assert.equal(h.state.value?.progress.pages_parsed, 1);
});

test("a failed page transaction leaves DO progress and discovery unchanged", async () => {
  const h = await harness();
  await processFetch(h.env, plugin, await h.current(), h.body, h.options);
  const before = structuredClone(h.state.value);
  const failDb = new Proxy(h.env.DB, {
    get(target, key) {
      if (key === "batch")
        return async () => {
          throw new Error("transaction failed");
        };
      return Reflect.get(target, key);
    },
  });
  await assert.rejects(
    processParse({ ...h.env, DB: failDb }, plugin, await h.current(), h.body, h.options),
    /transaction failed/u,
  );
  assert.deepEqual(h.state.value, before);
  assert.equal((await listCrawlFetchPages(h.db, RUN))[0]?.state, "fetched");
  await processParse(h.env, plugin, await h.current(), h.body, h.options);
  assert.equal(h.state.value?.progress.pages_parsed, 1);
});

test("discovered pages are committed once and recovered after a lost DO parse cursor", async () => {
  const h = await harness();
  h.sqlite.prepare("UPDATE crawl_fetch_sessions SET page_limit=5 WHERE run_id=?").run(RUN);
  await processFetch(h.env, plugin, await h.current(), h.body, h.options);
  const before = structuredClone(h.state.value);
  const session = await h.current();
  const discovered = "https://www.homeshokai.jp/itemlist.php?a=5";
  let discoveries = 0;
  const discoveringPlugin = {
    ...plugin,
    discovery: {
      ...plugin.discovery,
      discoverTargets() {
        discoveries += 1;
        return [discovered, discovered];
      },
    },
  };
  const first = await processParse(h.env, discoveringPlugin, session, h.body, h.options);
  assert.equal((await listCrawlFetchPages(h.db, RUN)).length, 4);
  h.state.value = before;
  const replay = await processParse(h.env, discoveringPlugin, session, h.body, h.options);
  assert.deepEqual(replay, first);
  assert.equal(discoveries, 1);
  assert.equal((await listCrawlFetchPages(h.db, RUN)).length, 4);
});

test("ignored pages and end-of-list coverage survive receipt replay and final checkpoint", async () => {
  const h = await harness();
  // Preserve the existing early-end policy while exercising the real parser and SQL transitions.
  const stopAtEmpty = {
    ...plugin,
    discovery: {
      ...plugin.discovery,
      policy: { ...plugin.discovery.policy, emptyPage: "stop" as const },
    },
  };
  await processFetch(h.env, plugin, await h.current(), h.body, h.options);
  await processParse(h.env, plugin, await h.current(), h.body, h.options);
  await processFetch(h.env, plugin, await h.current(), h.body, {
    ...h.options,
    fetchHtmlPage: async () => "<html></html>",
  });
  const before = structuredClone(h.state.value);
  const session = await h.current();
  await processParse(h.env, stopAtEmpty, session, h.body, h.options);
  const checkpoint = await getCrawlFetchSession(h.db, RUN);
  assert.equal(checkpoint?.next_phase, "finalize");
  assert.equal(checkpoint?.pages_fetched, 2);
  assert.equal(checkpoint?.pages_parsed, 2);
  assert.equal(checkpoint?.coverage_incomplete, 1);
  assert.equal(checkpoint?.reached_end, 1);
  h.state.value = before;
  await processParse(h.env, stopAtEmpty, session, h.body, h.options);
  assert.deepEqual(await getCrawlFetchSession(h.db, RUN), checkpoint);
  const pages = await listCrawlFetchPages(h.db, RUN);
  assert.equal(pages[2]?.state, "ignored");
  const finalized = await claimCrawlFetchFinalization(h.db, RUN, AT, AT);
  assert.ok(finalized);

  const missing = await harness();
  const missingSession = await missing.current();
  const missingBefore = structuredClone(missing.state.value);
  const result = await processFetch(missing.env, plugin, missingSession, missing.body, {
    ...missing.options,
    fetchHtmlPage: async () => {
      throw new Error("HTTP 404");
    },
  });
  missing.state.value = missingBefore;
  const replay = await processFetch(missing.env, plugin, missingSession, missing.body, {
    ...missing.options,
    fetchHtmlPage: async () => {
      throw new Error("must not refetch");
    },
  });
  assert.deepEqual(replay, result);
  assert.equal(missing.state.value?.progress.coverage_incomplete, 1);
  assert.equal(missing.state.value?.progress.pages_fetched, 0);
});

test("legacy sessions finish with D1 progress and mismatched DO generations fail closed", async () => {
  const h = await harness("d1");
  await processFetch(h.env, plugin, await h.current(), h.body, h.options);
  await processParse(h.env, plugin, await h.current(), h.body, h.options);
  assert.equal((await getCrawlFetchSession(h.db, RUN))?.continuation_sequence, 2);
  assert.equal((await listCrawlFetchPages(h.db, RUN))[0]?.progress_json, null);
  const fresh = await harness();
  const session = await fresh.current();
  assert.throws(() => withCollectionProgress(session), /requires its durable/u);
  assert.throws(
    () =>
      withCollectionProgress(session, {
        value: { runId: "another", progress: collectionProgress(session) },
      }),
    /another generation/u,
  );
});

test("CrawlScheduler persists its next command and progress in the same existing DO write", async () => {
  const h = await harness();
  h.sqlite
    .prepare(`INSERT INTO shop_sync_state(shop_key, dispatch_requested_at, dispatch_token, dispatch_last_sent_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(shop_key) DO UPDATE SET dispatch_requested_at=excluded.dispatch_requested_at,
    dispatch_token=excluded.dispatch_token, dispatch_last_sent_at=excluded.dispatch_last_sent_at`)
    .run(plugin.key, AT, RUN, AT);
  const session = await h.current();
  const settings = getCrawlerSettings(h.env);
  const stored = new Map<string, unknown>([
    [
      STORAGE_KEY,
      {
        message: { ...h.body, continuation: continuationFromSession(session) },
        acceptedAt: AT,
        nextOriginNotBeforeMs: 0,
        collectionProgress: h.state.value,
        permit: {
          targetUrl: session.next_page_key,
          userAgent: settings.userAgent,
          effectiveDelayMs: 0,
          preparedAtMs: 0,
          notBeforeMs: 0,
        },
      },
    ],
  ]);
  let failPut = true;
  let puts = 0;
  let alarms = 0;
  const ctx = {
    storage: {
      async get(key: string) {
        return structuredClone(stored.get(key));
      },
      async put(key: string, value: unknown) {
        if (failPut) throw new Error("DO commit interrupted");
        puts += 1;
        stored.set(key, structuredClone(value));
      },
      async setAlarm() {
        alarms += 1;
      },
    },
  } as unknown as DurableObjectState;
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(HTML, { headers: { "content-type": "text/html" } });
  };
  try {
    await assert.rejects(
      new CrawlScheduler(ctx, h.env as unknown as Env).alarm(),
      /DO commit interrupted/u,
    );
    failPut = false;
    // Recreate the object to discard every in-memory mutation, like an Alarm retry after eviction.
    await new CrawlScheduler(ctx, h.env as unknown as Env).alarm();
    assert.equal(fetches, 1);
    assert.equal(puts, 1, "progress reuses the command write");
    assert.equal(alarms, 1, "no progress-specific Alarm");
    const execution = stored.get(STORAGE_KEY) as {
      message: { continuation: { sequence: number; phase: string } };
      collectionProgress: NonNullable<CollectionProgressState["value"]>;
    };
    assert.equal(execution.message.continuation.sequence, 1);
    assert.equal(execution.message.continuation.phase, "parse");
    assert.equal(execution.collectionProgress.progress.continuation_sequence, 1);
    assert.equal(execution.collectionProgress.progress.pages_fetched, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
