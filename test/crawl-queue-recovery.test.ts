import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { recoverStalledCrawlDispatches } from "../src/crawler/dispatch.js";
import {
  crawlDispatchToken,
  reserveShopDispatch,
  tryClaimShopCrawl,
} from "../src/db/shop-state-repository.js";
import type { CrawlQueueMessage } from "../src/crawler/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

function recoveryEnv(
  db: ReturnType<typeof migratedSqlite>["db"],
  onMessage: (message: CrawlQueueMessage) => void,
): Parameters<typeof recoverStalledCrawlDispatches>[0] {
  return {
    DB: db,
    CRAWL_SCHEDULER: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { type: string; message: CrawlQueueMessage };
          assert.equal(body.type, "start_crawl");
          onMessage(body.message);
          return new Response(null, { status: 202 });
        },
      }),
    },
  } as unknown as Parameters<typeof recoverStalledCrawlDispatches>[0];
}

test("the scheduler watchdog re-sends the same stale child to its Durable Object", async () => {
  const { db } = migratedSqlite();
  const requestedAt = "2026-08-23T00:00:00.000Z";
  const now = new Date("2026-08-23T01:00:00.000Z");
  const dispatchToken = await reserveShopDispatch(db, "home-shokai", requestedAt, 120);
  assert.equal(dispatchToken, crawlDispatchToken("home-shokai", requestedAt));

  const sent: CrawlQueueMessage[] = [];
  const env = recoveryEnv(db, (message) => sent.push(message));

  const recovered = await recoverStalledCrawlDispatches(env, { now, recoveryMinutes: 30 });

  assert.deepEqual(recovered, ["home-shokai"]);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    {
      shopKey: sent[0]?.shopKey,
      force: sent[0]?.force,
      requestedAt: sent[0]?.requestedAt,
      jobId: sent[0]?.jobId,
    },
    {
      shopKey: "home-shokai",
      force: true,
      requestedAt,
      jobId: dispatchToken,
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
  const env = recoveryEnv(db, () => {
    sends += 1;
  });

  const recovered = await recoverStalledCrawlDispatches(env, { now, recoveryMinutes: 30 });
  assert.deepEqual(recovered, []);
  assert.equal(sends, 0);
});
