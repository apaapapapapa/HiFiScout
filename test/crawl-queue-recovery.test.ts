import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import {
  crawlDispatchToken,
  getShopState,
  reserveShopDispatch,
  tryClaimShopCrawl,
} from "../src/db/shop-state-repository.js";
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
