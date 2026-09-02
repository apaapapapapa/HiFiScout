import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { migratedSqlite } from "./helpers/migrated-sqlite.js";

type Sqlite = ReturnType<typeof migratedSqlite>["sqlite"];

interface IndexRow {
  catalog_product_id: number;
  asking_sample_count: number;
  asking_median_yen: number | null;
  asking_min_yen: number | null;
  asking_max_yen: number | null;
  recent_asking_median_yen: number | null;
  listing_end_sample_count: number;
  listing_end_median_yen: number | null;
  sold_out_signal_count: number;
  deactivated_signal_count: number;
}

const AGGREGATE_COLUMNS = `
  catalog_product_id, asking_sample_count, asking_median_yen, asking_min_yen, asking_max_yen,
  recent_asking_median_yen, listing_end_sample_count, listing_end_median_yen,
  sold_out_signal_count, deactivated_signal_count
`;

function emptyLedger(): ReturnType<typeof migratedSqlite> {
  const database = migratedSqlite();
  database.sqlite.exec(`
    DELETE FROM knowledge_catalog_price_index_samples;
    DELETE FROM knowledge_catalog_price_indexes;
    DELETE FROM knowledge_catalog_products;
  `);
  return database;
}

function insertCatalogProducts(sqlite: Sqlite, count: number): void {
  const statement = sqlite.prepare(`
    INSERT INTO knowledge_catalog_products
      (id, manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at)
    VALUES (?, 'luxman', ?, ?, ?, '2026-01-01', '2026-01-01')
  `);
  for (let id = 1; id <= count; id += 1) statement.run(id, `M-${id}`, `M-${id}`, `Luxman M-${id}`);
}

/**
 * A ledger spanning everything the statistics branch on: odd and even sample counts (the median
 * takes one value or averages two), prices out of insertion order, samples inside and outside the
 * ninety-day recent window, both listing-end signal kinds, and products holding only one kind.
 */
function seedLedger(sqlite: Sqlite, products: number): void {
  const sample = sqlite.prepare(`
    INSERT INTO knowledge_catalog_price_index_samples
      (event_key, catalog_product_id, listing_product_id, shop_key, source_id, sample_kind,
       signal_kind, price_yen, observed_at, created_at)
    VALUES (?, ?, ?, 'shop', 's', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')
  `);
  let event = 0;
  for (let product = 1; product <= products; product += 1) {
    const askingCount = (product % 4) + 1;
    for (let index = 0; index < askingCount; index += 1) {
      event += 1;
      const recent = index % 2 === 0;
      sample.run(
        `asking-${event}`,
        product,
        event,
        "asking",
        "asking",
        1000 * ((index * 7) % 5) + product,
        recent ? "2026-08-20T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
      );
    }
    const endCount = product % 3;
    for (let index = 0; index < endCount; index += 1) {
      event += 1;
      sample.run(
        `end-${event}`,
        product,
        event,
        "listing_end",
        index % 2 === 0 ? "sold_out" : "deactivated",
        index === 1 ? null : 500 * (index + 1) + product,
        "2026-08-01T00:00:00.000Z",
      );
    }
  }
}

function persisted(sqlite: Sqlite): IndexRow[] {
  return sqlite
    .prepare(
      `SELECT ${AGGREGATE_COLUMNS} FROM knowledge_catalog_price_indexes ORDER BY catalog_product_id`,
    )
    .all() as unknown as IndexRow[];
}

/** The whole-ledger definition the scoped triggers must keep agreeing with. */
function wholeLedgerRollup(sqlite: Sqlite): IndexRow[] {
  return sqlite
    .prepare(
      `SELECT ${AGGREGATE_COLUMNS} FROM knowledge_catalog_price_index_rollup ORDER BY catalog_product_id`,
    )
    .all() as unknown as IndexRow[];
}

test("scoped trigger aggregates match the whole-ledger rollup after inserts", () => {
  const { sqlite } = emptyLedger();
  insertCatalogProducts(sqlite, 12);

  seedLedger(sqlite, 12);

  const stored = persisted(sqlite);
  assert.ok(stored.length > 0, "the ledger must actually produce aggregates");
  assert.deepEqual(stored, wholeLedgerRollup(sqlite));
  sqlite.close();
});

test("scoped trigger aggregates match the whole-ledger rollup after a sample moves product", () => {
  const { sqlite } = emptyLedger();
  insertCatalogProducts(sqlite, 6);
  seedLedger(sqlite, 6);

  // Both the old and the new aggregate have to be recomputed, which is the update trigger's job.
  sqlite
    .prepare(
      "UPDATE knowledge_catalog_price_index_samples SET catalog_product_id = 2 WHERE catalog_product_id = 5",
    )
    .run();

  assert.deepEqual(persisted(sqlite), wholeLedgerRollup(sqlite));
  sqlite.close();
});

test("scoped trigger aggregates match the whole-ledger rollup after deletes", () => {
  const { sqlite } = emptyLedger();
  insertCatalogProducts(sqlite, 6);
  seedLedger(sqlite, 6);

  sqlite
    .prepare("DELETE FROM knowledge_catalog_price_index_samples WHERE sample_kind = 'listing_end'")
    .run();

  assert.deepEqual(persisted(sqlite), wholeLedgerRollup(sqlite));
  sqlite.close();
});

test("a catalog product whose last sample is deleted keeps no price index row", () => {
  const { sqlite } = emptyLedger();
  insertCatalogProducts(sqlite, 3);
  seedLedger(sqlite, 3);
  assert.ok(persisted(sqlite).some((row) => Number(row.catalog_product_id) === 2));

  sqlite
    .prepare("DELETE FROM knowledge_catalog_price_index_samples WHERE catalog_product_id = 2")
    .run();

  assert.equal(
    persisted(sqlite).some((row) => Number(row.catalog_product_id) === 2),
    false,
  );
  assert.deepEqual(persisted(sqlite), wholeLedgerRollup(sqlite));
  sqlite.close();
});

test("recomputing one product reads only that product's samples", () => {
  const { sqlite } = emptyLedger();
  const plan = sqlite
    .prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM knowledge_catalog_price_index_rollup WHERE catalog_product_id = 1
    `)
    .all() as { detail: string }[];
  // The whole-ledger view is why the scoped triggers exist: its window CTEs block the predicate.
  assert.ok(
    plan.some((row) => row.detail.startsWith("SCAN knowledge_catalog_price_index_samples")),
    "the whole-ledger view still scans the ledger, which is what the triggers must avoid",
  );

  const trigger = (
    sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_price_index_sample_insert'",
      )
      .get() as { sql: string }
  ).sql;
  assert.doesNotMatch(
    trigger,
    /knowledge_catalog_price_index_rollup/u,
    "the write path must not go through the whole-ledger view",
  );
  assert.match(trigger, /WHERE catalog_product_id = NEW\.catalog_product_id/u);
  sqlite.close();
});
