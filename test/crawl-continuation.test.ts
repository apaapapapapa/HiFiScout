import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  RESUMABLE_CRAWL_STAGES,
  resumeCrawlRun,
  resumeInterruptedCrawlRuns,
} from "../src/crawler/crawl-continuation.js";
import {
  completeCrawlRunStage,
  listResumableCrawlRuns,
  recordCrawlRunWorkSet,
  type ResumableCrawlRun,
} from "../src/db/crawl-run-continuation-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { asQueryableDatabase } from "./helpers/d1.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

type Sqlite = ReturnType<typeof migratedSqlite>["sqlite"];

const SHOP = "ippinkan";
const GENERATION = "2026-08-25T12:00:00.000Z";
const NOW = new Date("2026-08-25T12:30:00.000Z");

function emptyDatabase(): ReturnType<typeof migratedSqlite> {
  const database = migratedSqlite();
  database.sqlite.exec(`
    DELETE FROM product_search_entity_offers;
    DELETE FROM product_search_entities;
    DELETE FROM product_identity_resolutions;
    DELETE FROM product_search_projection;
    DELETE FROM products;
  `);
  return database;
}

/** A listing carrying the canonical fields every derived stage reads. */
function insertListing(sqlite: Sqlite, sourceId: string, model: string): void {
  sqlite
    .prepare(`
      INSERT INTO products (
        shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
        is_active, manufacturer, raw_manufacturer, manufacturer_id, canonical_manufacturer_id,
        manufacturer_resolution_status, model, raw_model, normalized_model,
        model_resolution_status, primary_category_id, category_ids, classification_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'DENON', 'DENON', 'denon', 'denon', 'resolved',
                ?, ?, ?, 'resolved', 'integrated_amp', '["integrated_amp"]', 'classified')
    `)
    .run(
      SHOP,
      sourceId,
      `DENON ${model}`,
      `https://example.test/${sourceId}`,
      GENERATION,
      GENERATION,
      GENERATION,
      model,
      model,
      model.replace(/[^A-Z0-9]/gu, ""),
    );
}

function startRun(sqlite: Sqlite): number {
  return Number(
    sqlite
      .prepare("INSERT INTO crawl_runs (shop_key, started_at, status) VALUES (?, ?, 'running')")
      .run(SHOP, GENERATION).lastInsertRowid,
  );
}

function stageRows(sqlite: Sqlite, crawlRunId: number) {
  return sqlite
    .prepare(`
      SELECT stage, status, after_source_id, processed_count, attempts
      FROM crawl_run_stages WHERE crawl_run_id = ? ORDER BY ordinal
    `)
    .all(crawlRunId) as Array<{
    stage: string;
    status: string;
    after_source_id: string;
    processed_count: number;
    attempts: number;
  }>;
}

function countRows(sqlite: Sqlite, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

async function arrangeInterruptedRun(
  database: ReturnType<typeof migratedSqlite>,
  sourceIds: readonly string[],
): Promise<ResumableCrawlRun> {
  const { sqlite, db } = database;
  sourceIds.forEach((sourceId, index) => insertListing(sqlite, sourceId, `PMA-${1000 + index}`));
  const crawlRunId = startRun(sqlite);
  await recordCrawlRunWorkSet(db, {
    crawlRunId,
    generation: GENERATION,
    sourceIds,
    recordedAt: GENERATION,
  });
  return { crawlRunId, shopKey: SHOP, generation: GENERATION };
}

test("a crawl that finished its stages inline leaves nothing to resume", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const run = await arrangeInterruptedRun(database, ["a-1", "a-2"]);

  for (const stage of RESUMABLE_CRAWL_STAGES) {
    await completeCrawlRunStage(db, run.crawlRunId, stage, GENERATION);
  }

  assert.deepEqual(await listResumableCrawlRuns(db, 10), []);
  assert.deepEqual(
    stageRows(sqlite, run.crawlRunId).map((row) => row.status),
    ["done", "done", "done", "done"],
  );
});

test("an interrupted crawl resumes only the stages it still owes", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const run = await arrangeInterruptedRun(database, ["b-1", "b-2", "b-3"]);
  // The invocation died after the projection but before identity resolution.
  await completeCrawlRunStage(db, run.crawlRunId, "search_projection", GENERATION);

  assert.deepEqual(await listResumableCrawlRuns(db, 10), [run]);

  const result = await resumeCrawlRun(db, run, { now: NOW });

  assert.equal(result.superseded, false);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.completedStages, [
    "identity_resolution",
    "search_entity",
    "membership_cleanup",
  ]);
  assert.deepEqual(
    stageRows(sqlite, run.crawlRunId).map((row) => row.status),
    ["done", "done", "done", "done"],
  );
  assert.equal(
    countRows(sqlite, "product_identity_resolutions"),
    3,
    "the resumed stage wrote a resolution for every observed listing",
  );
  assert.deepEqual(await listResumableCrawlRuns(db, 10), []);
  assert.equal(countRows(sqlite, "crawl_run_work_items"), 0, "a finished run frees its work set");
});

test("resume is bounded and continues from the persisted cursor", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const run = await arrangeInterruptedRun(database, ["c-1", "c-2", "c-3", "c-4"]);

  const first = await resumeCrawlRun(db, run, { now: NOW, chunkSize: 2, maxChunks: 1 });
  assert.equal(first.chunkCount, 1);
  assert.equal(first.processedCount, 2);
  assert.equal(first.hasMore, true);
  const afterFirst = stageRows(sqlite, run.crawlRunId)[0];
  assert.equal(afterFirst?.stage, "search_projection");
  assert.equal(afterFirst?.status, "pending");
  assert.equal(afterFirst?.after_source_id, "c-2", "the cursor stops where the chunk stopped");

  // A backlog drains over successive sweeps rather than in one unbounded invocation.
  let guard = 0;
  let hasMore = true;
  while (hasMore && guard < 20) {
    hasMore = (await resumeCrawlRun(db, run, { now: NOW, chunkSize: 2, maxChunks: 1 })).hasMore;
    guard += 1;
  }
  assert.ok(guard < 20, "resume converges");
  assert.deepEqual(
    stageRows(sqlite, run.crawlRunId).map((row) => row.status),
    ["done", "done", "done", "done"],
  );
  assert.equal(countRows(sqlite, "product_search_projection"), 4);
});

test("stages resume in dependency order", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const run = await arrangeInterruptedRun(database, ["d-1", "d-2"]);

  // One chunk at a time, so the order stages are entered is observable.
  const entered: string[] = [];
  for (let index = 0; index < RESUMABLE_CRAWL_STAGES.length; index += 1) {
    const pending = stageRows(sqlite, run.crawlRunId).find((row) => row.status === "pending");
    if (pending) entered.push(pending.stage);
    await resumeCrawlRun(db, run, { now: NOW, chunkSize: 10, maxChunks: 1 });
  }

  assert.deepEqual(entered, [...RESUMABLE_CRAWL_STAGES]);
});

test("a newer run for the shop retires the older run's outstanding work", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const run = await arrangeInterruptedRun(database, ["e-1", "e-2"]);
  // A later crawl observed the same shop, so finishing this one would project stale observations.
  startRun(sqlite);

  const result = await resumeCrawlRun(db, run, { now: NOW });

  assert.equal(result.superseded, true);
  assert.equal(result.processedCount, 0);
  assert.deepEqual(
    stageRows(sqlite, run.crawlRunId).map((row) => row.status),
    ["superseded", "superseded", "superseded", "superseded"],
  );
  assert.equal(countRows(sqlite, "crawl_run_work_items"), 0);
  assert.equal(countRows(sqlite, "product_identity_resolutions"), 0);
});

test("replaying a resumed run writes no duplicates", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const run = await arrangeInterruptedRun(database, ["f-1", "f-2"]);

  await resumeCrawlRun(db, run, { now: NOW });
  const projections = countRows(sqlite, "product_search_projection");
  const resolutions = countRows(sqlite, "product_identity_resolutions");

  // A redelivered sweep finds no pending stage and must change nothing.
  const replay = await resumeCrawlRun(db, run, { now: NOW });
  assert.equal(replay.processedCount, 0);
  assert.equal(countRows(sqlite, "product_search_projection"), projections);
  assert.equal(countRows(sqlite, "product_identity_resolutions"), resolutions);
});

test("a failing chunk leaves the cursor unmoved so the next sweep replays it", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const run = await arrangeInterruptedRun(database, ["g-1", "g-2"]);
  const failing = asQueryableDatabase({
    prepare(sql: string) {
      if (/INSERT INTO product_search_projection/u.test(sql)) throw new Error("D1 unavailable");
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  }) as QueryableDatabase;

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await resumeCrawlRun(failing, run, { now: NOW });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.hasMore, true);
  assert.equal(
    countRows(sqlite, "crawl_run_work_items"),
    2,
    "an unfinished run keeps the work set its pending stage still has to read",
  );
  const projection = stageRows(sqlite, run.crawlRunId)[0];
  assert.equal(projection?.status, "pending");
  assert.equal(projection?.after_source_id, "", "a failed chunk never advances the cursor");
  assert.equal(projection?.attempts, 1);

  // The same work succeeds once the database recovers.
  const recovered = await resumeCrawlRun(db, run, { now: NOW });
  assert.equal(recovered.hasMore, false);
  assert.equal(countRows(sqlite, "product_search_projection"), 2);
});

test("the sweep drains several runs within a bounded run limit", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const runs = [
    await arrangeInterruptedRun(database, ["h-1"]),
    await arrangeInterruptedRun(database, ["i-1"]),
  ];
  // The older run is superseded by the newer one for the same shop; both still get visited.
  const results = await resumeInterruptedCrawlRuns(db, { now: NOW, runLimit: 1 });

  assert.equal(results.length, 1, "the run limit bounds one sweep");
  assert.equal(results[0]?.crawlRunId, runs[0]?.crawlRunId, "the oldest run is taken first");
  assert.equal(results[0]?.superseded, true);

  const remaining = await resumeInterruptedCrawlRuns(db, { now: NOW, runLimit: 1 });
  assert.equal(remaining[0]?.crawlRunId, runs[1]?.crawlRunId);
  assert.equal(remaining[0]?.superseded, false);
  assert.deepEqual(await listResumableCrawlRuns(db, 10), []);
  assert.equal(countRows(sqlite, "crawl_run_work_items"), 0);
});

function offerCount(sqlite: Sqlite, sourceId: string): number {
  return (
    sqlite
      .prepare(`
        SELECT COUNT(*) AS count
        FROM product_search_entity_offers m
        JOIN products p ON p.id = m.listing_product_id
        WHERE p.shop_key = ? AND p.source_id = ?
      `)
      .get(SHOP, sourceId) as { count: number }
  ).count;
}

function deactivate(sqlite: Sqlite, sourceId: string): void {
  sqlite
    .prepare("UPDATE products SET is_active = 0 WHERE shop_key = ? AND source_id = ?")
    .run(SHOP, sourceId);
}

/** A later crawl over listings that already exist. An empty delta still owes the shop cleanup. */
async function startFollowUpRun(
  database: ReturnType<typeof migratedSqlite>,
  sourceIds: readonly string[] = [],
): Promise<ResumableCrawlRun> {
  const crawlRunId = startRun(database.sqlite);
  await recordCrawlRunWorkSet(database.db, {
    crawlRunId,
    generation: GENERATION,
    sourceIds,
    recordedAt: GENERATION,
  });
  return { crawlRunId, shopKey: SHOP, generation: GENERATION };
}

test("the entity stage leaves the shop-wide sweep to the cleanup stage", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const first = await arrangeInterruptedRun(database, ["j-1", "j-2"]);
  await resumeCrawlRun(db, first, { now: NOW });
  assert.equal(offerCount(sqlite, "j-1"), 1);

  deactivate(sqlite, "j-1");
  const run = await startFollowUpRun(database, ["j-2"]);
  for (const stage of ["search_projection", "identity_resolution"] as const) {
    await completeCrawlRunStage(db, run.crawlRunId, stage, GENERATION);
  }

  // One chunk, so the run stops after the entity stage and before cleanup. Scanning the whole shop
  // from inside a per-chunk stage is the whole-shop recomputation chunking exists to remove.
  const entityOnly = await resumeCrawlRun(db, run, { now: NOW, maxChunks: 1 });
  assert.deepEqual(entityOnly.completedStages, ["search_entity"]);
  assert.equal(offerCount(sqlite, "j-1"), 1);

  const cleanup = await resumeCrawlRun(db, run, { now: NOW });
  assert.deepEqual(cleanup.completedStages, ["membership_cleanup"]);
  assert.equal(offerCount(sqlite, "j-1"), 0, "the cleanup stage retires the departed offer");
  assert.equal(offerCount(sqlite, "j-2"), 1, "a listing that is still on sale keeps its offer");
});

test("cleanup drains a backlog of departed listings in bounded chunks", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const sourceIds = ["k-1", "k-2", "k-3"];
  const first = await arrangeInterruptedRun(database, sourceIds);
  await resumeCrawlRun(db, first, { now: NOW });
  for (const sourceId of sourceIds) deactivate(sqlite, sourceId);

  const run = await startFollowUpRun(database);
  for (const stage of ["search_projection", "identity_resolution", "search_entity"] as const) {
    await completeCrawlRunStage(db, run.crawlRunId, stage, GENERATION);
  }

  const partial = await resumeCrawlRun(db, run, { now: NOW, chunkSize: 1, maxChunks: 1 });
  assert.equal(partial.hasMore, true);
  assert.equal(partial.processedCount, 1);
  const checkpoint = stageRows(sqlite, run.crawlRunId).at(-1);
  assert.equal(checkpoint?.stage, "membership_cleanup");
  assert.equal(checkpoint?.after_source_id, "k-1", "the cursor stops where the chunk stopped");
  assert.equal(offerCount(sqlite, "k-2"), 1, "later chunks are still owed");

  let guard = 0;
  let hasMore = true;
  while (hasMore && guard < 10) {
    hasMore = (await resumeCrawlRun(db, run, { now: NOW, chunkSize: 1, maxChunks: 1 })).hasMore;
    guard += 1;
  }
  assert.ok(guard < 10, "cleanup converges");
  assert.equal(countRows(sqlite, "product_search_entity_offers"), 0);
});

test("an exhausted time budget defers the remaining work instead of finishing it", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const run = await arrangeInterruptedRun(database, ["m-1", "m-2"]);

  // The invocation the platform kills runs no catch or finally block, so stopping short is the only
  // way a checkpoint survives. It is an ordinary outcome: the work is already durable.
  const deferred = await resumeCrawlRun(db, run, { now: NOW, budgetMs: 0 });

  assert.equal(deferred.hasMore, true);
  assert.equal(deferred.processedCount, 0);
  assert.deepEqual(deferred.completedStages, []);
  assert.equal(countRows(sqlite, "crawl_run_work_items"), 2, "deferred work keeps its work set");
  assert.deepEqual(await listResumableCrawlRuns(db, 10), [run]);

  const finished = await resumeCrawlRun(db, run, { now: NOW });
  assert.equal(finished.hasMore, false);
  assert.equal(countRows(sqlite, "product_search_projection"), 2);
  assert.equal(countRows(sqlite, "crawl_run_work_items"), 0);
});

test("a large work set drains through several bounded invocations", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  // The size the incident shop reports. Nothing here declares it large; the runner is bounded
  // because every shop uses the same chunk budget, not because this one was classified correctly.
  const sourceIds = Array.from(
    { length: 750 },
    (_, index) => `n-${String(index).padStart(4, "0")}`,
  );
  const run = await arrangeInterruptedRun(database, sourceIds);

  let invocations = 0;
  let hasMore = true;
  while (hasMore && invocations < 20) {
    const result = await resumeCrawlRun(db, run, { now: NOW });
    assert.ok(result.chunkCount <= 12, "no invocation exceeds its chunk budget");
    hasMore = result.hasMore;
    invocations += 1;
  }

  assert.ok(invocations > 1, "the work set is larger than one invocation may take");
  assert.ok(invocations < 20, "successive sweeps converge");
  assert.deepEqual(
    stageRows(sqlite, run.crawlRunId).map((row) => row.status),
    ["done", "done", "done", "done"],
  );
  assert.equal(countRows(sqlite, "product_search_projection"), 750);
  assert.equal(countRows(sqlite, "product_identity_resolutions"), 750);
  assert.equal(countRows(sqlite, "crawl_run_work_items"), 0);
});

test("a newer run adopts what the interrupted run never projected", async () => {
  const database = emptyDatabase();
  const { sqlite, db } = database;
  const interrupted = await arrangeInterruptedRun(database, ["p-1", "p-2"]);

  // The next crawl sees listings that already match what the interrupted run wrote, so its own
  // delta is empty. Dropping the older work set on supersession would strand both projections.
  const next = await startFollowUpRun(database, []);
  const result = await resumeCrawlRun(db, next, { now: NOW });

  assert.equal(result.superseded, false);
  assert.equal(countRows(sqlite, "product_search_projection"), 2);
  assert.equal(countRows(sqlite, "product_identity_resolutions"), 2);

  const retired = await resumeCrawlRun(db, interrupted, { now: NOW });
  assert.equal(
    retired.superseded,
    true,
    "the older run is retired only after its work was adopted",
  );
  assert.equal(countRows(sqlite, "crawl_run_work_items"), 0);
});
