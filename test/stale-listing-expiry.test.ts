import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import {
  expireStaleListings,
  hasRecentSuccessfulCrawls,
} from "../src/db/product-write-stale-expiry.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  assertNoGrowingTableScans,
  assertNoSortBeforeLimit,
  queryPlan,
  readsThroughIndex,
  recordingDatabase,
  selects,
} from "./helpers/query-plan.js";

const NOW = "2026-10-22T00:00:00.000Z";
const EXPIRY = {
  unknownBefore: "2026-10-08T00:00:00.000Z",
  limit: 50,
};
const FRESH = "2026-10-21T00:00:00.000Z";
const AGING = "2026-10-05T00:00:00.000Z";
const ANCIENT = "2026-09-01T00:00:00.000Z";

interface ListingOptions {
  shop?: string;
  seen: string;
  stock?: "in_stock" | "sold_out" | "unknown";
  active?: number;
  checked?: string | null;
  confirmed?: string | null;
  failures?: number;
}

/** Listings `prefix1..prefixN` of one shop, all in the same state. */
function insertListings(
  db: QueryableDatabase,
  prefix: string,
  count: number,
  {
    shop = "shop",
    seen,
    stock = "in_stock",
    active = 1,
    checked = null,
    confirmed = null,
    failures = 0,
  }: ListingOptions,
) {
  return db
    .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
      INSERT INTO products(shop_key,source_id,title,source_url,first_seen_at,last_seen_at,
        last_changed_at,last_activity_at,stock_status,is_active,last_inventory_checked_at,
        inventory_check_failures,last_confirmed_available_at)
      SELECT ?,?||i,'Amp','https://example.test/'||?||i,?,?,?,?,?,?,?,?,? FROM n`)
    .bind(
      count,
      shop,
      prefix,
      prefix,
      ANCIENT,
      seen,
      seen,
      seen,
      stock,
      active,
      checked,
      failures,
      confirmed,
    )
    .run();
}

async function state(db: QueryableDatabase, sourceId: string, shop = "shop") {
  return db
    .prepare(
      "SELECT is_active, stock_status, last_changed_at FROM products WHERE shop_key = ? AND source_id = ?",
    )
    .bind(shop, sourceId)
    .first<{ is_active: number; stock_status: string; last_changed_at: string }>();
}

test("expiry never deactivates without sale evidence, even after 30 days", async () => {
  const { db, dispose } = await database();
  try {
    await insertListings(db, "ancient-", 2, { seen: ANCIENT });
    await insertListings(db, "ancient-sold-", 1, { seen: ANCIENT, stock: "sold_out" });
    await insertListings(db, "aging-", 2, { seen: AGING });
    await insertListings(db, "aging-sold-", 1, { seen: AGING, stock: "sold_out" });
    await insertListings(db, "fresh-", 2, { seen: FRESH });
    // Only explicit positive evidence newer than the horizon protects availability.
    await insertListings(db, "vouched-", 1, { seen: ANCIENT, checked: FRESH, confirmed: FRESH });
    await insertListings(db, "vouched-aging-", 1, {
      seen: AGING,
      checked: FRESH,
      confirmed: FRESH,
    });
    await insertListings(db, "failing-", 1, { seen: ANCIENT, checked: FRESH, failures: 1 });
    await insertListings(db, "old-check-", 1, { seen: ANCIENT, checked: ANCIENT });
    await insertListings(db, "observed-", 1, { seen: ANCIENT });
    await insertListings(db, "other-", 1, { shop: "other", seen: ANCIENT });

    const result = await expireStaleListings(db, "shop", EXPIRY, new Set(["observed-1"]), NOW);

    assert.deepEqual(result.deactivatedSourceIds, []);
    const unknownIds = ["ancient-1", "ancient-2", "failing-1", "old-check-1", "aging-1", "aging-2"];
    assert.deepEqual(new Set(result.unknownSourceIds), new Set(unknownIds));
    assert.equal((await state(db, "ancient-sold-1"))?.is_active, 1);
    for (const id of unknownIds) {
      const row = await state(db, id);
      assert.equal(row?.is_active, 1);
      assert.equal(row?.stock_status, "unknown");
      assert.equal(row?.last_changed_at, NOW);
    }
    // Sold stays sold, fresh and vouched listings stay as they are, the running crawl's own
    // observations and other shops are never touched.
    assert.equal((await state(db, "aging-sold-1"))?.stock_status, "sold_out");
    for (const id of ["fresh-1", "vouched-1", "vouched-aging-1", "observed-1"]) {
      const row = await state(db, id);
      assert.equal(row?.is_active, 1, id);
      assert.equal(row?.stock_status, "in_stock", id);
    }
    assert.equal((await state(db, "other-1", "other"))?.is_active, 1);

    // Replaying the same expiry finds nothing left to change.
    const replay = await expireStaleListings(db, "shop", EXPIRY, new Set(["observed-1"]), NOW);
    assert.deepEqual(replay, { deactivatedSourceIds: [], unknownSourceIds: [] });
  } finally {
    await dispose();
  }
}, 120_000);

test("expiry changes at most its limit per step, oldest first", async () => {
  const { db, dispose } = await database();
  try {
    await insertListings(db, "ancient-", 5, { seen: ANCIENT });
    await insertListings(db, "older-", 3, { seen: "2026-08-01T00:00:00.000Z" });
    await insertListings(db, "aging-", 5, { seen: AGING });
    const result = await expireStaleListings(db, "shop", { ...EXPIRY, limit: 3 }, new Set(), NOW);
    assert.deepEqual(new Set(result.unknownSourceIds), new Set(["older-1", "older-2", "older-3"]));
    assert.equal(result.unknownSourceIds.length, 3);
    assert.deepEqual(result.deactivatedSourceIds, []);
  } finally {
    await dispose();
  }
}, 120_000);

test("expiry seeks the active last-seen index without sorting or scanning the shop", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  try {
    const { db, executed } = recordingDatabase(inner);
    await insertListings(inner, "ancient-", 1, { seen: ANCIENT });
    await insertListings(inner, "aging-", 1, { seen: AGING });
    await expireStaleListings(db, "shop", EXPIRY, new Set(), NOW);
    assert.equal(selects(executed).length, 2);
    assertNoGrowingTableScans(sqlite, executed, {
      label: "stale listing expiry",
      allowances: [
        {
          tables: ["same_time", "later"],
          when: /WITH same_time AS MATERIALIZED/,
          reason:
            "Both CTEs share a fixed 50-row budget and are fed by bounded seeks; no growing table is scanned.",
        },
      ],
    });
    assertNoSortBeforeLimit(sqlite, executed, "stale listing expiry");
    for (const statement of selects(executed).filter((statement) =>
      statement.sql.includes("FROM products"),
    )) {
      const plan = queryPlan(sqlite, statement);
      assert.ok(
        readsThroughIndex(plan, "products", "idx_products_active_last_seen"),
        plan.map((step) => step.detail).join("\n"),
      );
    }
  } finally {
    sqlite.close();
  }
});

test("expiry reads the stale listings, not the shop's recently seen inventory", async () => {
  const { db, dispose } = await database();
  const fixture = ["test/stale-listing-expiry.test.ts"];
  const STALE = 50;
  try {
    let previous = 0;
    const reads: number[] = [];
    for (const size of [100, 1000, 10000]) {
      // Growth the expiry must never visit: recently seen listings of the shop and another shop's
      // ancient ones.
      await insertListings(db, `fresh-${size}-`, size - previous, { seen: FRESH });
      await insertListings(db, `other-${size}-`, (size - previous) / 4, {
        shop: "other",
        seen: ANCIENT,
      });
      previous = size;
      await insertListings(db, `ancient-${size}-`, STALE, { seen: ANCIENT });
      await insertListings(db, `aging-${size}-`, STALE, { seen: AGING });

      await db.prepare("DELETE FROM shop_sync_state WHERE shop_key = ?").bind("shop").run();
      const boundary = measureD1Cost(db);
      const result = await expireStaleListings(boundary.db, "shop", EXPIRY, new Set(), NOW);
      const cost = boundary.metrics();
      console.log(JSON.stringify({ sample: `crawl-expire-stale-${size}`, ...cost }));
      assert.equal(result.deactivatedSourceIds.length, 0);
      assert.equal(result.unknownSourceIds.length, STALE);
      assert.equal(cost.sqlStatements, 4, JSON.stringify(cost)); // bounded cursor read/write plus product select/update
      reads.push(cost.rowsRead ?? -1);
      await recordCostSample(`crawl-expire-stale-${size}`, "local-workerd", cost, fixture, [
        `${STALE} long-unseen and ${STALE} aging in-stock listings among ${size} recently seen active listings of the same shop; real migrated D1.`,
      ]);
      // Reset both cohorts outside measurement so every size has identical stale inventory.
      await db
        .prepare("UPDATE products SET is_active = 0 WHERE source_id LIKE ? OR source_id LIKE ?")
        .bind(`aging-${size}-%`, `ancient-${size}-%`)
        .run();
    }
    assert.ok(Math.max(...reads) - Math.min(...reads) <= 2, `reads grew: ${reads}`);
  } finally {
    await dispose();
  }
}, 120_000);

test("expiry needs the shop's recent crawls to have kept succeeding", async () => {
  const { db, dispose } = await database();
  try {
    const run = (startedAt: string, status: string, shop = "shop") =>
      db
        .prepare("INSERT INTO crawl_runs(shop_key, started_at, status) VALUES (?, ?, ?)")
        .bind(shop, startedAt, status)
        .run();
    await run("2026-10-01T00:00:00.000Z", "success");
    await run("2026-10-10T00:00:00.000Z", "success");
    await run("2026-10-11T00:00:00.000Z", "failed");
    await run("2026-10-12T00:00:00.000Z", "success");
    await run("2026-10-13T00:00:00.000Z", "success", "other");
    const since = "2026-10-08T00:00:00.000Z";
    assert.equal(await hasRecentSuccessfulCrawls(db, "shop", since, 2), true);
    assert.equal(await hasRecentSuccessfulCrawls(db, "shop", since, 3), false);
    assert.equal(await hasRecentSuccessfulCrawls(db, "other", since, 2), false);
  } finally {
    await dispose();
  }
}, 120_000);

test("unknown backlog is bounded even near the end of a shared last-seen timestamp", async () => {
  const { db, dispose } = await database();
  try {
    const reads: number[] = [];
    for (const size of [100, 1000, 10000]) {
      const shop = `backlog-${size}`;
      await insertListings(db, `unknown-${size}-`, size, { shop, seen: ANCIENT, stock: "unknown" });
      await insertListings(db, `late-${size}-`, 1, { shop, seen: ANCIENT });
      const row = await db
        .prepare("SELECT id FROM products WHERE shop_key=? AND source_id=?")
        .bind(shop, `unknown-${size}-${size - 10}`)
        .first<{ id: number }>();
      await db
        .prepare(`INSERT INTO shop_sync_state(shop_key,stale_inventory_cursor_seen_at,stale_inventory_cursor_id)
        VALUES (?,?,?)`)
        .bind(shop, ANCIENT, row!.id)
        .run();
      const boundary = measureD1Cost(db);
      const result = await expireStaleListings(boundary.db, shop, EXPIRY, new Set(), NOW);
      assert.deepEqual(result.unknownSourceIds, [`late-${size}-1`]);
      const cost = boundary.metrics();
      console.log(JSON.stringify({ backlog: size, ...cost }));
      if (cost.rowsRead !== null) {
        assert.ok(cost.rowsRead < 150, JSON.stringify(cost));
        reads.push(cost.rowsRead);
      }
      assert.ok(cost.sqlStatements <= 4);
      const replay = measureD1Cost(db);
      const unchanged = await expireStaleListings(replay.db, shop, EXPIRY, new Set(), NOW);
      assert.deepEqual(unchanged.unknownSourceIds, []);
    }
    if (reads.length) assert.ok(Math.max(...reads) - Math.min(...reads) <= 2, String(reads));
  } finally {
    await dispose();
  }
}, 120_000);
