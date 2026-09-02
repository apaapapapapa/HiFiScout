import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  crawlDispatchToken,
  releaseShopDispatch,
  reserveShopDispatch,
} from "../src/db/shop-state-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

interface DispatchState {
  dispatch_requested_at: string | null;
  dispatch_token: string | null;
  dispatch_last_sent_at: string | null;
}

function dispatchState(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  shopKey: string,
): DispatchState {
  return sqlite
    .prepare(
      `SELECT dispatch_requested_at, dispatch_token, dispatch_last_sent_at
       FROM shop_sync_state WHERE shop_key = ?`,
    )
    .get(shopKey) as unknown as DispatchState;
}

test("one immutable dispatch generation is reserved per shop until explicit release", async () => {
  const { sqlite, db } = migratedSqlite();
  const requestedAt = "2026-08-21T00:00:00.000Z";
  const dispatchToken = await reserveShopDispatch(db, "hifido", requestedAt, 120);
  assert.equal(dispatchToken, crawlDispatchToken("hifido", requestedAt));

  assert.equal(await reserveShopDispatch(db, "hifido", "2026-08-21T01:30:00.000Z", 120), null);

  const active = dispatchState(sqlite, "hifido");
  assert.equal(active.dispatch_requested_at, requestedAt);
  assert.equal(active.dispatch_token, dispatchToken);
  assert.equal(active.dispatch_last_sent_at, requestedAt);

  await releaseShopDispatch(db, "hifido", "wrong-token");
  assert.equal(dispatchState(sqlite, "hifido").dispatch_token, dispatchToken);

  await releaseShopDispatch(db, "hifido", dispatchToken);
  const released = dispatchState(sqlite, "hifido");
  assert.equal(released.dispatch_requested_at, null);
  assert.equal(released.dispatch_token, null);
  assert.equal(released.dispatch_last_sent_at, null);
});

test("a quiet dispatch cannot be superseded before its owning token is released", async () => {
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
