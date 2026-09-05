import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import { deferredPriceIndexRefresh } from "../src/db/knowledge-catalog-price-index-deferred-refresh.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  assertNoGrowingTableScans,
  queryPlan,
  readsThroughIndex,
  recordingDatabase,
  selects,
} from "./helpers/query-plan.js";

/**
 * What a batch of sample writes costs in aggregate recomputes.
 *
 * Migration 0071 made each sample trigger recompute one catalog product rather than the whole
 * ledger, which is the right cost when a path writes one or two samples. The price-history backfill
 * writes up to fifty at once, and repeats catalog products within a page: every row pays a full
 * recompute of a product whose answer only the last row of that product leaves standing, and the
 * recompute reads four passes over every sample the product already has.
 *
 * Migration 0080 gives the triggers a deferred half. Inside a deferral they record which products
 * changed; the batch drains that record in the same transaction. These tests pin both halves of the
 * bargain: that the coalescing happens, and that the aggregate it commits is indistinguishable from
 * the one the per-row path would have produced.
 */

/**
 * Counts aggregate recomputes by observing writes to the aggregate table.
 *
 * A recompute is not otherwise visible -- an upsert that lands the same values leaves no trace in
 * the row -- so the count is taken where the writes happen rather than inferred from the result.
 */
function countRecomputes(sqlite: DatabaseSync): () => number {
  sqlite.exec(`
    CREATE TABLE test_recompute_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT);
    CREATE TRIGGER test_recompute_insert AFTER INSERT ON knowledge_catalog_price_indexes
    BEGIN INSERT INTO test_recompute_log(at) VALUES ('insert'); END;
    CREATE TRIGGER test_recompute_update AFTER UPDATE ON knowledge_catalog_price_indexes
    BEGIN INSERT INTO test_recompute_log(at) VALUES ('update'); END;
    CREATE TRIGGER test_recompute_delete AFTER DELETE ON knowledge_catalog_price_indexes
    BEGIN INSERT INTO test_recompute_log(at) VALUES ('delete'); END;
  `);
  const baseline = () =>
    Number(
      (sqlite.prepare("SELECT COUNT(*) AS n FROM test_recompute_log").get() as { n: number }).n,
    );
  const before = baseline();
  return () => baseline() - before;
}

const PRODUCTS = [9001, 9002, 9003] as const;

function fixture() {
  const database = migratedSqlite();
  database.sqlite.exec(`
    INSERT INTO products
      (shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
    VALUES ('shop', 'src-1', 'Listing', 'https://example.test/1',
            datetime('now'), datetime('now'), datetime('now'), 1);
    INSERT INTO knowledge_catalog_manufacturers (id, canonical_name, created_at, updated_at)
    VALUES ('luxman', 'Luxman', datetime('now'), datetime('now'));
  `);
  eventId = 0;
  for (const [index, id] of PRODUCTS.entries()) {
    database.sqlite
      .prepare(`
        INSERT INTO knowledge_catalog_products
          (id, manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at)
        VALUES (?, 'luxman', ?, ?, ?, datetime('now'), datetime('now'))
      `)
      .run(id, `L-${index}`, `l${index}`, `Luxman L-${index}`);
  }
  return database;
}

/**
 * Event keys are numbered per database, not per process.
 *
 * Each test builds its own in-memory database, so a shared counter would make the key a test needs
 * to name depend on how many samples every earlier test happened to write.
 */
let eventId = 0;

/** An asking sample, as a prepared statement so it can go into a batch. */
function sample(db: QueryableDatabase, catalogProductId: number, priceYen: number) {
  eventId += 1;
  return db
    .prepare(`
      INSERT INTO knowledge_catalog_price_index_samples(
        event_key, catalog_product_id, listing_product_id, shop_key, source_id,
        sample_kind, signal_kind, price_yen, observed_at
      ) VALUES (?, ?, (SELECT id FROM products WHERE shop_key = 'shop' AND source_id = 'src-1'), 'shop', ?, 'asking', 'asking', ?,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'))
    `)
    .bind(`deferred-${eventId}`, catalogProductId, `source-${eventId}`, priceYen);
}

/** Every stored aggregate, without `last_computed_at`, which is a clock reading rather than a value. */
function aggregates(sqlite: DatabaseSync): unknown[] {
  return sqlite
    .prepare(`
      SELECT catalog_product_id, asking_sample_count, asking_median_yen, asking_min_yen,
             asking_max_yen, recent_asking_median_yen, listing_end_sample_count,
             listing_end_median_yen, sold_out_signal_count, deactivated_signal_count
      FROM knowledge_catalog_price_indexes
      ORDER BY catalog_product_id
    `)
    .all();
}

/** Products repeated within one page: ten samples for one, five for another, one for a third. */
const PAGE: readonly number[] = [
  ...Array.from({ length: 10 }, () => PRODUCTS[0]),
  ...Array.from({ length: 5 }, () => PRODUCTS[1]),
  PRODUCTS[2],
];

test("a batch recomputes each product it touched once, not once per row", async () => {
  const { sqlite, db } = fixture();
  const recomputes = countRecomputes(sqlite);

  await db.batch(
    deferredPriceIndexRefresh(
      db,
      "page",
      PAGE.map((product, index) => sample(db, product, 250_000 + index)),
    ),
  );

  assert.equal(
    recomputes(),
    PRODUCTS.length,
    "sixteen samples across three products should cost three recomputes",
  );
});

test("the aggregate a deferred batch commits is the one the per-row path computes", async () => {
  // The whole bargain. Coalescing is only allowed to change how often the answer is computed.
  const perRow = fixture();
  await perRow.db.batch(PAGE.map((product, index) => sample(perRow.db, product, 250_000 + index)));

  const coalesced = fixture();
  await coalesced.db.batch(
    deferredPriceIndexRefresh(
      coalesced.db,
      "page",
      PAGE.map((product, index) => sample(coalesced.db, product, 250_000 + index)),
    ),
  );

  assert.deepEqual(aggregates(coalesced.sqlite), aggregates(perRow.sqlite));
  assert.equal(aggregates(perRow.sqlite).length, PRODUCTS.length, "and all three were written");
});

test("the aggregate is committed with the samples, not after them", async () => {
  // Synchronous is the point: nothing outside the transaction may see a sample without its
  // aggregate. The batch is one transaction, so observing the database after it is the only
  // observation an outside reader can make -- and by then both are there.
  const { sqlite, db } = fixture();
  await db.batch(deferredPriceIndexRefresh(db, "page", [sample(db, PRODUCTS[0], 250_000)]));

  const stored = sqlite
    .prepare(`
      SELECT asking_sample_count FROM knowledge_catalog_price_indexes WHERE catalog_product_id = ?
    `)
    .get(PRODUCTS[0]) as { asking_sample_count: number } | undefined;
  assert.equal(stored?.asking_sample_count, 1);
});

test("a sample that moves between products refreshes the one it left", async () => {
  // The reason the record is kept by the trigger and not assembled by the caller: after the row is
  // written, only `OLD` still knows which product the sample used to belong to.
  const { sqlite, db } = fixture();
  await db.batch([sample(db, PRODUCTS[0], 250_000), sample(db, PRODUCTS[0], 260_000)]);

  const moved = db
    .prepare(`
      UPDATE knowledge_catalog_price_index_samples SET catalog_product_id = ?
      WHERE event_key = 'deferred-2'
    `)
    .bind(PRODUCTS[1]);
  await db.batch(deferredPriceIndexRefresh(db, "move", [moved]));

  const counts = (
    sqlite
      .prepare(`
        SELECT catalog_product_id, asking_sample_count FROM knowledge_catalog_price_indexes
        ORDER BY catalog_product_id
      `)
      .all() as Array<{ catalog_product_id: number; asking_sample_count: number }>
  ).map((row) => ({
    catalog_product_id: row.catalog_product_id,
    asking_sample_count: row.asking_sample_count,
  }));
  assert.deepEqual(counts, [
    { catalog_product_id: PRODUCTS[0], asking_sample_count: 1 },
    { catalog_product_id: PRODUCTS[1], asking_sample_count: 1 },
  ]);
});

test("a product that loses its last sample loses its aggregate", async () => {
  const { sqlite, db } = fixture();
  await db.batch([sample(db, PRODUCTS[0], 250_000), sample(db, PRODUCTS[1], 260_000)]);
  assert.equal(aggregates(sqlite).length, 2);

  await db.batch(
    deferredPriceIndexRefresh(db, "drop", [
      db
        .prepare("DELETE FROM knowledge_catalog_price_index_samples WHERE catalog_product_id = ?")
        .bind(PRODUCTS[0]),
    ]),
  );

  const remaining = aggregates(sqlite) as Array<{ catalog_product_id: number }>;
  assert.deepEqual(
    remaining.map((row) => row.catalog_product_id),
    [PRODUCTS[1]],
    "an emptied product must not keep a stale aggregate",
  );
});

test("a batch that fails leaves no deferral and no aggregate behind", async () => {
  // Nothing about the deferral outlives its transaction, so a killed batch cannot leave the
  // triggers deferred for a path that has no drain of its own.
  const { sqlite, db } = fixture();
  const doomed = deferredPriceIndexRefresh(db, "doomed", [
    sample(db, PRODUCTS[0], 250_000),
    db.prepare("INSERT INTO knowledge_catalog_price_index_samples(event_key) VALUES ('broken')"),
  ]);

  await assert.rejects(db.batch(doomed));

  assert.equal(aggregates(sqlite).length, 0, "the samples rolled back, so no aggregate stands");
  const open = sqlite
    .prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_price_index_refresh_deferrals")
    .get() as { n: number };
  assert.equal(Number(open.n), 0, "the deferral rolled back with everything else");
  const dirty = sqlite
    .prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_price_index_dirty_products")
    .get() as { n: number };
  assert.equal(Number(dirty.n), 0);
});

test("paths that do not defer keep recomputing on every row", async () => {
  // The producer paths were not changed. A sample written outside a deferral still updates the
  // aggregate by itself, before and after a deferred batch has run.
  const { sqlite, db } = fixture();
  const recomputes = countRecomputes(sqlite);

  await sample(db, PRODUCTS[0], 250_000).run();
  assert.equal(recomputes(), 1);

  await db.batch(deferredPriceIndexRefresh(db, "page", [sample(db, PRODUCTS[0], 251_000)]));
  await sample(db, PRODUCTS[0], 252_000).run();

  const stored = sqlite
    .prepare(
      "SELECT asking_sample_count FROM knowledge_catalog_price_indexes WHERE catalog_product_id = ?",
    )
    .get(PRODUCTS[0]) as { asking_sample_count: number };
  assert.equal(stored.asking_sample_count, 3, "the immediate trigger still runs after a deferral");
});

test("draining reads the ledger through the catalog index, never end to end", async () => {
  // What 0071 bought must survive being generalised from one product to a set. The drain reads the
  // sample ledger once per statistic, and each of those reads has to be driven by the dirty set
  // through `idx_..._samples_catalog` -- otherwise coalescing sixteen recomputes into one would have
  // replaced sixteen indexed reads with one read of the entire ledger.
  const { sqlite, db: inner } = fixture();
  const recording = recordingDatabase(inner);
  await recording.db.batch(
    deferredPriceIndexRefresh(recording.db, "page", [sample(recording.db, PRODUCTS[0], 250_000)]),
  );

  assertNoGrowingTableScans(sqlite, recording.executed, {
    label: "price index drain",
    allowances: [
      {
        tables: ["catalog_ids", "asking_ranked", "recent_asking_ranked", "listing_end_ranked"],
        when: /FROM knowledge_catalog_price_index_dirty_products/u,
        reason:
          "co-routines over `scoped`, which the plan below is asserted to restrict to the dirty " +
          "products through the catalog index -- they cannot grow with the ledger, only with the page",
      },
    ],
  });

  const drain = selects(recording.executed).find((statement) =>
    /INSERT INTO knowledge_catalog_price_indexes/u.test(statement.sql),
  );
  assert.ok(drain, "the drain should be among the recorded statements");
  assert.ok(
    readsThroughIndex(
      queryPlan(sqlite, drain),
      "knowledge_catalog_price_index_samples",
      "idx_knowledge_catalog_price_index_samples_catalog",
    ),
    "the ledger must be reached through the catalog index",
  );
  assert.equal(
    queryPlan(sqlite, drain).filter((step) =>
      /^SCAN knowledge_catalog_price_index_samples\b(?!.*USING)/u.test(step.detail),
    ).length,
    0,
    "and never scanned outright",
  );
});

test("a page of a thousand samples for one product still recomputes it once", async () => {
  // The shape the change exists for. Ten more rows for a product carrying a thousand samples used
  // to re-read four thousand rows ten times over for one surviving answer.
  const { sqlite, db } = fixture();
  sqlite.exec("BEGIN");
  for (let index = 0; index < 1000; index += 1) {
    eventId += 1;
    sqlite
      .prepare(`
        INSERT INTO knowledge_catalog_price_index_samples(
          event_key, catalog_product_id, listing_product_id, shop_key, source_id,
          sample_kind, signal_kind, price_yen, observed_at
        ) VALUES (?, ?, (SELECT id FROM products WHERE shop_key = 'shop' AND source_id = 'src-1'), 'shop', ?, 'asking', 'asking', ?,
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'))
      `)
      .run(`pre-${eventId}`, PRODUCTS[0], `pre-${eventId}`, 200_000 + index);
  }
  sqlite.exec("COMMIT");

  const recomputes = countRecomputes(sqlite);
  await db.batch(
    deferredPriceIndexRefresh(
      db,
      "page",
      Array.from({ length: 10 }, (_, index) => sample(db, PRODUCTS[0], 250_000 + index)),
    ),
  );

  assert.equal(recomputes(), 1);
  const stored = sqlite
    .prepare(
      "SELECT asking_sample_count FROM knowledge_catalog_price_indexes WHERE catalog_product_id = ?",
    )
    .get(PRODUCTS[0]) as { asking_sample_count: number };
  assert.equal(stored.asking_sample_count, 1010);
});
