import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import { backfillKnowledgeCatalogPriceIndex } from "../src/db/knowledge-catalog-price-index-backfill.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const CATALOG_PRODUCT_ID = 9901;

function fixture(historyRows: number) {
  const database = migratedSqlite();
  database.sqlite.exec(`
    INSERT INTO knowledge_catalog_manufacturers (id, canonical_name, created_at, updated_at)
    VALUES ('replay-guard', 'Replay Guard', datetime('now'), datetime('now'));

    INSERT INTO knowledge_catalog_products
      (id, manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at)
    VALUES (
      ${CATALOG_PRODUCT_ID},
      'replay-guard',
      'RG-1',
      'rg1',
      'Replay Guard RG-1',
      datetime('now'),
      datetime('now')
    );

    INSERT INTO products
      (shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
    VALUES (
      'shop',
      'replay-guard',
      'Replay Guard RG-1',
      'https://example.test/replay-guard',
      datetime('now'),
      datetime('now'),
      datetime('now'),
      1
    );

    INSERT INTO product_identity_resolutions
      (listing_product_id, catalog_product_id, status, match_method, confidence, evaluated_at)
    SELECT id, ${CATALOG_PRODUCT_ID}, 'matched', 'exact', 'high', datetime('now')
    FROM products
    WHERE shop_key = 'shop' AND source_id = 'replay-guard';
  `);

  const listingId = Number(
    (
      database.sqlite
        .prepare("SELECT id FROM products WHERE shop_key = 'shop' AND source_id = 'replay-guard'")
        .get() as { id: number }
    ).id,
  );
  for (let index = 0; index < historyRows; index += 1) {
    database.sqlite
      .prepare(`
        INSERT INTO price_history(product_id, price_yen, observed_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'))
      `)
      .run(listingId, 300_000 + index);
  }

  // Build retained history first, then reproduce the historical gap this backfill repairs.
  database.sqlite.exec(`
    DELETE FROM knowledge_catalog_price_index_samples;
    DELETE FROM knowledge_catalog_price_indexes;
    DELETE FROM knowledge_catalog_price_index_recent_refreshes;
  `);
  return database;
}

const COORDINATION_TABLES = [
  "knowledge_catalog_price_indexes",
  "knowledge_catalog_price_index_dirty_products",
  "knowledge_catalog_price_index_refresh_deferrals",
] as const;

function billingWeight(sqlite: DatabaseSync, table: string): number {
  return 1 + (sqlite.prepare(`PRAGMA index_list('${table}')`).all() as unknown[]).length;
}

function countBilledCoordinationWrites(sqlite: DatabaseSync): {
  billed: () => number;
  clear: () => void;
} {
  sqlite.exec("CREATE TABLE test_replay_guard_billing_log (table_name TEXT NOT NULL)");
  for (const table of COORDINATION_TABLES) {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      sqlite.exec(`
        CREATE TRIGGER test_replay_guard_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table}
        BEGIN
          INSERT INTO test_replay_guard_billing_log(table_name) VALUES ('${table}');
        END;
      `);
    }
  }

  const billed = () =>
    COORDINATION_TABLES.reduce((sum, table) => {
      const rows = Number(
        (
          sqlite
            .prepare("SELECT COUNT(*) AS n FROM test_replay_guard_billing_log WHERE table_name = ?")
            .get(table) as { n: number }
        ).n,
      );
      return sum + rows * billingWeight(sqlite, table);
    }, 0);

  return {
    billed,
    clear: () => sqlite.exec("DELETE FROM test_replay_guard_billing_log"),
  };
}

test("fresh-key replay adds zero billed coordination writes", async () => {
  const { sqlite, db } = fixture(30);
  await backfillKnowledgeCatalogPriceIndex(db, {
    backfillKey: "replay-guard-seed",
    batchSize: 30,
  });

  const writes = countBilledCoordinationWrites(sqlite);
  const replay = await backfillKnowledgeCatalogPriceIndex(db, {
    backfillKey: "replay-guard-replay",
    batchSize: 30,
  });

  assert.equal(replay.selectedCount, 30);
  assert.equal(replay.writtenCount, 0, "all stable event keys are no-ops");
  assert.equal(
    writes.billed(),
    0,
    "a no-op replay must not open/close a deferral or rewrite an aggregate",
  );
});

test("partial replay below break-even stays on the per-row path", async () => {
  const { sqlite, db } = fixture(30);
  const seed = await backfillKnowledgeCatalogPriceIndex(db, {
    backfillKey: "partial-seed",
    batchSize: 24,
  });
  assert.equal(seed.writtenCount, 24);

  const writes = countBilledCoordinationWrites(sqlite);
  const replay = await backfillKnowledgeCatalogPriceIndex(db, {
    backfillKey: "partial-replay",
    batchSize: 30,
  });

  assert.equal(replay.selectedCount, 30);
  assert.equal(replay.writtenCount, 6, "only the six uncopied events mutate");
  assert.equal(
    writes.billed(),
    6,
    "six aggregate rewrites are cheaper than seven deferred coordination writes",
  );
});

test("a stale same-key batch cannot open a deferral after another invocation wins", async () => {
  const { sqlite, db } = fixture(30);
  const writes = countBilledCoordinationWrites(sqlite);
  let injectedWinner = false;

  const racingDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "batch") return Reflect.get(target, property, receiver);
      return async (statements: D1PreparedStatement[]) => {
        if (!injectedWinner) {
          injectedWinner = true;
          const winner = await backfillKnowledgeCatalogPriceIndex(db, {
            backfillKey: "same-key-race",
            batchSize: 30,
          });
          assert.equal(winner.writtenCount, 30);
          writes.clear();
        }
        return target.batch(statements);
      };
    },
  });

  const stale = await backfillKnowledgeCatalogPriceIndex(racingDb, {
    backfillKey: "same-key-race",
    batchSize: 30,
  });

  assert.equal(stale.writtenCount, 0, "the winner already copied every event");
  assert.equal(
    writes.billed(),
    0,
    "the stale transaction sees the advanced cursor and must not open a deferral",
  );
});
