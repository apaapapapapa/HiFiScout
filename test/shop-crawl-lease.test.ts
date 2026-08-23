import { test } from "vitest";
import assert from "node:assert/strict";
import {
  crawlDispatchToken,
  releaseShopCrawl,
  releaseShopDispatch,
  reserveShopDispatch,
  tryClaimShopCrawl,
} from "../src/db/shop-state-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

interface LeaseState {
  queued_at: string | null;
  queued_token: string | null;
  crawl_lease_token: string | null;
  crawl_lease_until: string | null;
}

function leaseState(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  shopKey: string,
): LeaseState {
  return sqlite
    .prepare(
      `SELECT queued_at, queued_token, crawl_lease_token, crawl_lease_until
       FROM shop_sync_state WHERE shop_key = ?`,
    )
    .get(shopKey) as unknown as LeaseState;
}

test("long queue wait keeps one dispatch and one live crawl per shop", async () => {
  const { sqlite, db } = migratedSqlite();
  const requestedAt = "2026-08-21T00:00:00.000Z";
  const dispatchToken = await reserveShopDispatch(db, "hifido", requestedAt, 120);
  assert.equal(dispatchToken, crawlDispatchToken("hifido", requestedAt));

  assert.equal(await reserveShopDispatch(db, "hifido", "2026-08-21T01:30:00.000Z", 120), null);

  const crawlToken = await tryClaimShopCrawl(
    db,
    "hifido",
    requestedAt,
    "2026-08-21T01:31:00.000Z",
    20,
  );
  assert.ok(crawlToken);

  assert.equal(
    await tryClaimShopCrawl(db, "hifido", requestedAt, "2026-08-21T01:32:00.000Z", 20),
    null,
  );

  await releaseShopCrawl(db, "hifido", crawlToken, requestedAt);
  const released = leaseState(sqlite, "hifido");
  assert.equal(released.queued_at, null);
  assert.equal(released.queued_token, null);
  assert.equal(released.crawl_lease_token, null);
  assert.equal(released.crawl_lease_until, null);

  assert.equal(
    await tryClaimShopCrawl(db, "hifido", requestedAt, "2026-08-21T01:33:00.000Z", 20),
    null,
  );
});

test("a stale-looking queued child cannot be superseded before explicit release", async () => {
  const { db } = migratedSqlite();
  const oldRequestedAt = "2026-08-21T00:00:00.000Z";
  const newRequestedAt = "2026-08-21T02:01:00.000Z";

  const oldToken = await reserveShopDispatch(db, "u-audio", oldRequestedAt, 120);
  assert.equal(oldToken, crawlDispatchToken("u-audio", oldRequestedAt));
  assert.equal(await reserveShopDispatch(db, "u-audio", newRequestedAt, 120), null);

  await releaseShopDispatch(db, "u-audio", oldToken);
  assert.equal(
    await reserveShopDispatch(db, "u-audio", newRequestedAt, 120),
    crawlDispatchToken("u-audio", newRequestedAt),
  );
});
