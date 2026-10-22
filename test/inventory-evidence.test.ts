import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { decideInventoryState, type InventoryStateInput } from "../src/inventory/state.js";
import {
  markInventoryAmbiguous,
  markInventoryAvailable,
  markInventoryCheckAttempt,
  recordInventoryUnavailable,
} from "../src/db/inventory-recheck-repository.js";
import { expireStaleListings } from "../src/db/product-write-stale-expiry.js";
import { migrationSources } from "./helpers/migrations.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const OLD = "2026-09-01T00:00:00.000Z";
const NOW = "2026-10-22T00:00:00.000Z";
const RECENT = "2026-10-21T00:00:00.000Z";
const BEFORE = "2026-10-08T00:00:00.000Z";
const input: InventoryStateInput = {
  stockStatus: "in_stock",
  lastSeenAt: OLD,
  lastConfirmedAvailableAt: null,
  lastCheckedAt: null,
  failureCount: 0,
  latest: "not_checked",
  observedAt: NOW,
  unknownBefore: BEFORE,
  failureThreshold: 2,
};

test("pure inventory policy separates positive, ambiguous, deferred and repeated negative evidence", () => {
  assert.equal(decideInventoryState(input).action, "mark_unknown");
  assert.equal(decideInventoryState({ ...input, lastCheckedAt: RECENT }).action, "mark_unknown");
  assert.equal(decideInventoryState({ ...input, lastConfirmedAvailableAt: RECENT }).action, "keep");
  const available = decideInventoryState({ ...input, latest: "in_stock", failureCount: 1 });
  assert.equal(available.lastConfirmedAvailableAt, NOW);
  assert.equal(available.failureCount, 0);
  const first = decideInventoryState({ ...input, latest: "sold_out" });
  assert.equal(first.action, "keep");
  assert.equal(first.failureCount, 1);
  assert.equal(first.stockStatus, "sold_out");
  const second = { ...input, lastCheckedAt: RECENT, failureCount: 1, latest: "sold_out" as const };
  assert.equal(decideInventoryState(second).action, "deactivate_confirmed");
  assert.equal(decideInventoryState({ ...second, lastSeenAt: NOW }).action, "keep");
  const ambiguous = decideInventoryState({ ...second, latest: "unknown" });
  assert.equal(ambiguous.action, "mark_unknown");
  assert.equal(ambiguous.failureCount, 0);
  assert.equal(ambiguous.lastConfirmedAvailableAt, null);
  const deferred = decideInventoryState({ ...second, latest: "deferred" });
  assert.equal(deferred.action, "defer");
  assert.equal(deferred.failureCount, 1);
  assert.equal(decideInventoryState({ ...second, observedAt: RECENT }).action, "defer");
  assert.equal(
    decideInventoryState({ ...input, latest: "sold_out", failureThreshold: 1 }).action,
    "keep",
  );
});

function seed(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]) {
  sqlite
    .prepare(`INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,first_seen_at,last_seen_at,last_changed_at,last_inventory_checked_at)
    VALUES(1,'shop','1','Amp','https://example.test/1','in_stock',?,?,?,?)`)
    .run(OLD, OLD, OLD, RECENT);
}

test("migration never promotes historical attempts into positive availability evidence", () => {
  const { sqlite } = migratedSqlite({ before: "0142_inventory_availability_evidence.sql" });
  try {
    seed(sqlite);
    sqlite.exec(
      migrationSources.find((m) => m.name === "0142_inventory_availability_evidence.sql")!.sql,
    );
    assert.equal(
      sqlite.prepare("SELECT last_confirmed_available_at FROM products WHERE id=1").get()
        ?.last_confirmed_available_at,
      null,
    );
    assert.equal(
      sqlite.prepare("SELECT last_inventory_checked_at FROM products WHERE id=1").get()
        ?.last_inventory_checked_at,
      RECENT,
    );
  } finally {
    sqlite.close();
  }
});

test("unknown attempts cannot protect ancient stock, and only new positive evidence advances availability", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    seed(sqlite);
    const state = () =>
      sqlite
        .prepare(
          "SELECT stock_status,is_active,inventory_check_failures,last_confirmed_available_at,last_inventory_checked_at FROM products WHERE id=1",
        )
        .get()!;
    await markInventoryAmbiguous(db, 1, NOW);
    assert.equal(state().stock_status, "unknown");
    assert.equal(state().last_confirmed_available_at, null);
    assert.equal((await markInventoryAmbiguous(db, 1, NOW)).meta.changes, 0);
    const positive = "2026-10-23T00:00:00.000Z";
    await markInventoryAvailable(db, 1, positive);
    assert.equal(state().last_confirmed_available_at, positive);
    assert.equal(state().stock_status, "in_stock");
    assert.equal((await markInventoryAvailable(db, 1, positive)).meta.changes, 0);
    const aging = await expireStaleListings(
      db,
      "shop",
      { unknownBefore: BEFORE, limit: 50 },
      new Set(),
      positive,
    );
    assert.deepEqual(aging.unknownSourceIds, []);
    await markInventoryCheckAttempt(db, 1, "2026-10-24T00:00:00.000Z");
    assert.equal(state().last_confirmed_available_at, positive);
    await markInventoryAmbiguous(db, 1, "2026-10-24T00:00:00.000Z");
    assert.equal(state().last_confirmed_available_at, positive);
    assert.equal(state().is_active, 1);
  } finally {
    sqlite.close();
  }
});

test("sold confirmation, positive reset, ambiguous reset and duplicate replay preserve evidence contracts", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    seed(sqlite);
    const state = () => sqlite.prepare("SELECT * FROM products WHERE id=1").get()!;
    await recordInventoryUnavailable(db, 1, NOW, 1, false, "sold");
    assert.equal(state().is_active, 1);
    assert.equal(state().inventory_check_failures, 1);
    await markInventoryAvailable(db, 1, "2026-10-23T00:00:00.000Z");
    assert.equal(state().inventory_check_failures, 0);
    await recordInventoryUnavailable(db, 1, "2026-10-24T00:00:00.000Z", 1, false, "sold");
    await markInventoryAmbiguous(db, 1, "2026-10-25T00:00:00.000Z");
    assert.equal(state().inventory_check_failures, 0);
    assert.equal(state().stock_status, "sold_out");
    await recordInventoryUnavailable(db, 1, "2026-10-26T00:00:00.000Z", 1, false, "sold");
    await recordInventoryUnavailable(db, 1, "2026-10-27T00:00:00.000Z", 2, true, "sold");
    assert.equal(state().is_active, 0);
    assert.equal(
      (await recordInventoryUnavailable(db, 1, "2026-10-27T00:00:00.000Z", 2, true, "sold")).meta
        .changes,
      0,
    );
    assert.equal(state().last_confirmed_available_at, "2026-10-23T00:00:00.000Z");
  } finally {
    sqlite.close();
  }
});
