import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { recoverStalledCrawlDispatches } from "../src/crawler/dispatch.js";
import {
  crawlDispatchToken,
  getShopState,
  reserveShopDispatch,
  tryClaimShopCrawl,
} from "../src/db/shop-state-repository.js";
import type { CrawlQueueMessage } from "../src/crawler/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

test("a redelivery while the same child crawl lease is live is retried instead of acknowledged", async () => {
  const { db } = migratedSqlite();
  const requestedAt = new Date(Date.now() - 1_000).toISOString();
  const dispatchToken = await reserveShopDispatch(db, "hifido", requestedAt, 120);
  assert.equal(dispatchToken, crawlDispatchToken("hifido", requestedAt));

  const claimedAt = new Date().toISOString();
  const crawlToken = await tryClaimShopCrawl(db, "hifido", requestedAt, claimedAt, 20);
  assert.ok(crawlToken);

  let acknowledgements = 0;
  const retryDelays: number[] = [];
  const batch = {
    queue: "hifiscout-crawl-relay",
    messages: [
      {
        body: {
          shopKey: "hifido",
          force: false,
          requestedAt,
          jobId: dispatchToken,
          batchRunId: "crawl-batch:test",
          lane: "relay",
        },
        ack() {
          acknowledgements += 1;
        },
        retry(options?: { delaySeconds?: number }) {
          retryDelays.push(options?.delaySeconds || 0);
        },
      },
    ],
  } as unknown as Parameters<typeof worker.queue>[0];
  const env = { DB: db } as unknown as Parameters<typeof worker.queue>[1];

  await worker.queue(batch, env);

  assert.equal(acknowledgements, 0);
  assert.equal(retryDelays.length, 1);
  assert.ok(retryDelays[0] > 60);
  const state = await getShopState(db, "hifido");
  assert.equal(state?.consecutive_failures, 0);
  assert.equal(state?.backoff_until, null);
});

test("the scheduler watchdog re-sends the same stale child instead of replacing its identity", async () => {
  const { db } = migratedSqlite();
  const requestedAt = "2026-08-23T00:00:00.000Z";
  const now = new Date("2026-08-23T01:00:00.000Z");
  const dispatchToken = await reserveShopDispatch(db, "home-shokai", requestedAt, 120);
  assert.equal(dispatchToken, crawlDispatchToken("home-shokai", requestedAt));

  const sent: CrawlQueueMessage[] = [];
  const env = {
    DB: db,
    CRAWL_FAST_QUEUE: {
      async send(message: CrawlQueueMessage) {
        sent.push(message);
      },
    },
  } as unknown as Parameters<typeof recoverStalledCrawlDispatches>[0];

  const recovered = await recoverStalledCrawlDispatches(env, { now, recoveryMinutes: 30 });

  assert.deepEqual(recovered, ["home-shokai"]);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    {
      shopKey: sent[0]?.shopKey,
      force: sent[0]?.force,
      requestedAt: sent[0]?.requestedAt,
      jobId: sent[0]?.jobId,
      lane: sent[0]?.lane,
    },
    {
      shopKey: "home-shokai",
      force: true,
      requestedAt,
      jobId: dispatchToken,
      lane: "fast",
    },
  );

  const state = await db
    .prepare(
      "SELECT queued_at, queued_token, queued_last_sent_at FROM shop_sync_state WHERE shop_key = ?",
    )
    .bind("home-shokai")
    .first<{ queued_at: string; queued_token: string; queued_last_sent_at: string }>();
  assert.equal(state?.queued_at, requestedAt);
  assert.equal(state?.queued_token, dispatchToken);
  assert.equal(state?.queued_last_sent_at, now.toISOString());

  const immediateRepeat = await recoverStalledCrawlDispatches(env, {
    now: new Date(now.getTime() + 5 * 60_000),
    recoveryMinutes: 30,
  });
  assert.deepEqual(immediateRepeat, []);
  assert.equal(sent.length, 1);
});

test("the scheduler watchdog does not duplicate a child with a live crawl lease", async () => {
  const { db } = migratedSqlite();
  const requestedAt = "2026-08-23T00:00:00.000Z";
  const now = new Date("2026-08-23T01:00:00.000Z");
  await reserveShopDispatch(db, "home-shokai", requestedAt, 120);
  const crawlToken = await tryClaimShopCrawl(
    db,
    "home-shokai",
    requestedAt,
    new Date(now.getTime() - 5 * 60_000).toISOString(),
    20,
  );
  assert.ok(crawlToken);

  let sends = 0;
  const env = {
    DB: db,
    CRAWL_FAST_QUEUE: {
      async send() {
        sends += 1;
      },
    },
  } as unknown as Parameters<typeof recoverStalledCrawlDispatches>[0];

  const recovered = await recoverStalledCrawlDispatches(env, { now, recoveryMinutes: 30 });
  assert.deepEqual(recovered, []);
  assert.equal(sends, 0);
});

test("crawl DLQ releases only the failed child reservation for the next scheduler sweep", async () => {
  const { db } = migratedSqlite();
  const requestedAt = new Date().toISOString();
  const dispatchToken = await reserveShopDispatch(db, "home-shokai", requestedAt, 120);
  assert.equal(dispatchToken, crawlDispatchToken("home-shokai", requestedAt));

  let acknowledgements = 0;
  let retries = 0;
  const batch = {
    queue: "hifiscout-crawl-fast-dlq",
    messages: [
      {
        body: {
          shopKey: "home-shokai",
          force: false,
          requestedAt,
          jobId: dispatchToken,
          batchRunId: "crawl-batch:test",
          lane: "fast",
        },
        ack() {
          acknowledgements += 1;
        },
        retry() {
          retries += 1;
        },
      },
    ],
  } as unknown as Parameters<typeof worker.queue>[0];
  const env = { DB: db } as unknown as Parameters<typeof worker.queue>[1];

  await worker.queue(batch, env);

  assert.equal(acknowledgements, 1);
  assert.equal(retries, 0);
  assert.equal((await getShopState(db, "home-shokai"))?.queued_at, null);
});
