import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import { backfillKnowledgeCatalogPriceIndex } from "../src/db/knowledge-catalog-price-index-backfill.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

/**
 * What one page of the price-history backfill costs in aggregate recomputes.
 *
 * The job copies a bounded keyset page of `price_history` into the permanent sample ledger. A page
 * is drawn in `ph.id` order, so its shape varies: deep history is many rows for one listing, while
 * the recent tail is one row each for many listings. The first shape used to pay a full recompute of
 * the same catalog product once per row.
 *
 * The page now runs under a refresh deferral when -- and only when -- coalescing pays for itself.
 * These tests pin both branches, and that either way the page still lands as one transaction.
 */

const CATALOG_PRODUCT = 9001;

function backfillFixture(): { sqlite: DatabaseSync; db: ReturnType<typeof migratedSqlite>["db"] } {
  const database = migratedSqlite();
  database.sqlite.exec(`
    INSERT INTO knowledge_catalog_manufacturers (id, canonical_name, created_at, updated_at)
    VALUES ('luxman', 'Luxman', datetime('now'), datetime('now'));
    INSERT INTO knowledge_catalog_products
      (id, manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at)
    VALUES (${CATALOG_PRODUCT}, 'luxman', 'L-507', 'l507', 'Luxman L-507',
            datetime('now'), datetime('now'));
  `);
  return database;
}

/** Another catalog product, so a page can touch more than one. */
function catalogProduct(sqlite: DatabaseSync, index: number): number {
  const id = CATALOG_PRODUCT + 1 + index;
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_products
        (id, manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at)
      VALUES (?, 'luxman', ?, ?, ?, datetime('now'), datetime('now'))
    `)
    .run(id, `L-${index}`, `l${index}`, `Luxman L-${index}`);
  return id;
}

/**
 * A listing with `historyRows` retained price observations and no samples for them.
 *
 * This is the state the backfill exists to repair: price history kept from before the sample ledger
 * covered it. Everything written through today's triggers is already captured as it happens -- a
 * price_history insert on a matched listing lands a sample, and so does a resolution becoming
 * matched -- so the fixture builds the rows the normal way and then clears the ledger, rather than
 * pretending some path leaves it behind.
 */
function listingWithRetainedHistory(
  sqlite: DatabaseSync,
  sourceId: string,
  historyRows: number,
  catalogProductId: number = CATALOG_PRODUCT,
): number {
  const listingId = Number(
    sqlite
      .prepare(`
        INSERT INTO products
          (shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
        VALUES ('shop', ?, 'Luxman L-507', 'https://example.test/' || ?,
                datetime('now'), datetime('now'), datetime('now'), 1)
      `)
      .run(sourceId, sourceId).lastInsertRowid,
  );
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions
        (listing_product_id, catalog_product_id, status, match_method, confidence, evaluated_at)
      VALUES (?, ?, 'matched', 'exact', 'high', datetime('now'))
    `)
    .run(listingId, catalogProductId);
  for (let index = 0; index < historyRows; index += 1) {
    sqlite
      .prepare(`
        INSERT INTO price_history(product_id, price_yen, observed_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'))
      `)
      .run(listingId, 250_000 + index);
  }
  sqlite.exec(`
    DELETE FROM knowledge_catalog_price_index_samples;
    DELETE FROM knowledge_catalog_price_indexes;
  `);
  return listingId;
}

/** Counts writes to the aggregate table, which is the only place a recompute is observable. */
function countRecomputes(sqlite: DatabaseSync): () => number {
  sqlite.exec(`
    CREATE TABLE test_recompute_log (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TRIGGER test_recompute_insert AFTER INSERT ON knowledge_catalog_price_indexes
    BEGIN INSERT INTO test_recompute_log(id) VALUES (NULL); END;
    CREATE TRIGGER test_recompute_update AFTER UPDATE ON knowledge_catalog_price_indexes
    BEGIN INSERT INTO test_recompute_log(id) VALUES (NULL); END;
  `);
  const count = () =>
    Number(
      (sqlite.prepare("SELECT COUNT(*) AS n FROM test_recompute_log").get() as { n: number }).n,
    );
  const before = count();
  return () => count() - before;
}

function sampleCount(sqlite: DatabaseSync): number {
  return Number(
    (
      sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_price_index_samples").get() as {
        n: number;
      }
    ).n,
  );
}

test("a page of one listing's history recomputes its product once", async () => {
  const { sqlite, db } = backfillFixture();
  listingWithRetainedHistory(sqlite, "deep", 30);
  const recomputes = countRecomputes(sqlite);

  const result = await backfillKnowledgeCatalogPriceIndex(db, {
    backfillKey: "coalescing-deep",
    batchSize: 30,
  });

  assert.equal(result.selectedCount, 30);
  assert.equal(result.writtenCount, 30, "every selected row is still copied");
  assert.equal(recomputes(), 1, "thirty samples for one product cost one recompute");
  const stored = sqlite
    .prepare(
      "SELECT asking_sample_count FROM knowledge_catalog_price_indexes WHERE catalog_product_id = ?",
    )
    .get(CATALOG_PRODUCT) as { asking_sample_count: number };
  assert.equal(stored.asking_sample_count, 30);
});

test("a page of one row each per product takes the unchanged path", async () => {
  // Nothing to coalesce: every row is a different product, so a deferral would cost a marker per
  // product and save no recompute. The page is left to the per-row triggers exactly as before.
  const { sqlite, db } = backfillFixture();
  for (let index = 0; index < 12; index += 1) {
    listingWithRetainedHistory(sqlite, `wide-${index}`, 1, catalogProduct(sqlite, index));
  }
  const recomputes = countRecomputes(sqlite);

  const result = await backfillKnowledgeCatalogPriceIndex(db, {
    backfillKey: "coalescing-wide",
    batchSize: 12,
  });

  assert.equal(result.selectedCount, 12);
  assert.equal(recomputes(), 12, "one recompute per row, as before the deferral existed");
  const dirty = sqlite
    .prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_price_index_dirty_products")
    .get() as { n: number };
  assert.equal(Number(dirty.n), 0, "and no deferral bookkeeping was written");
});

test("separate listings of one product are not coalesced, and are still correct", async () => {
  // The documented conservatism. The page is judged by its listings, because the candidate scan
  // deliberately does not read catalog attribution -- resolving that is the transaction's job. Twelve
  // listings that happen to share one catalog product therefore look like twelve products and take
  // the per-row path. That costs recomputes it could have saved; it does not cost correctness.
  const { sqlite, db } = backfillFixture();
  for (let index = 0; index < 12; index += 1) {
    listingWithRetainedHistory(sqlite, `shared-${index}`, 1);
  }
  const recomputes = countRecomputes(sqlite);

  await backfillKnowledgeCatalogPriceIndex(db, { backfillKey: "shared", batchSize: 12 });

  assert.equal(recomputes(), 12);
  const stored = sqlite
    .prepare(
      "SELECT asking_sample_count FROM knowledge_catalog_price_indexes WHERE catalog_product_id = ?",
    )
    .get(CATALOG_PRODUCT) as { asking_sample_count: number };
  assert.equal(stored.asking_sample_count, 12, "the aggregate is right either way");
});

test("the aggregate a coalesced page commits matches the per-row result exactly", async () => {
  const aggregateOf = (sqlite: DatabaseSync) =>
    sqlite
      .prepare(`
        SELECT catalog_product_id, asking_sample_count, asking_median_yen, asking_min_yen,
               asking_max_yen, recent_asking_median_yen, listing_end_sample_count,
               listing_end_median_yen, sold_out_signal_count, deactivated_signal_count
        FROM knowledge_catalog_price_indexes ORDER BY catalog_product_id
      `)
      .all();

  // The same thirty observations, copied a page at a time. A batch of one can never coalesce, so
  // that run is the per-row baseline; a batch of thirty takes the deferred path.
  const perRow = backfillFixture();
  listingWithRetainedHistory(perRow.sqlite, "deep", 30);
  for (let page = 0; page < 30; page += 1) {
    await backfillKnowledgeCatalogPriceIndex(perRow.db, { backfillKey: "row", batchSize: 1 });
  }

  const coalesced = backfillFixture();
  listingWithRetainedHistory(coalesced.sqlite, "deep", 30);
  await backfillKnowledgeCatalogPriceIndex(coalesced.db, { backfillKey: "page", batchSize: 30 });

  assert.equal(sampleCount(perRow.sqlite), 30);
  assert.deepEqual(aggregateOf(coalesced.sqlite), aggregateOf(perRow.sqlite));
});

test("replaying a coalesced page writes nothing and leaves the aggregate where it was", async () => {
  const { sqlite, db } = backfillFixture();
  listingWithRetainedHistory(sqlite, "deep", 30);
  await backfillKnowledgeCatalogPriceIndex(db, { backfillKey: "replay", batchSize: 30 });
  const settled = sqlite
    .prepare(
      "SELECT asking_sample_count FROM knowledge_catalog_price_indexes WHERE catalog_product_id = ?",
    )
    .get(CATALOG_PRODUCT) as { asking_sample_count: number };

  // A fresh key re-selects the same rows the first run already copied. The sample event key is
  // stable, so the upserts find nothing to change.
  const recomputes = countRecomputes(sqlite);
  const replay = await backfillKnowledgeCatalogPriceIndex(db, {
    backfillKey: "replay-again",
    batchSize: 30,
  });

  assert.equal(replay.selectedCount, 30);
  assert.equal(replay.writtenCount, 0, "an unchanged sample is not rewritten");
  assert.equal(sampleCount(sqlite), 30, "and no duplicate samples appear");
  assert.equal(
    (
      sqlite
        .prepare(
          "SELECT asking_sample_count FROM knowledge_catalog_price_indexes WHERE catalog_product_id = ?",
        )
        .get(CATALOG_PRODUCT) as { asking_sample_count: number }
    ).asking_sample_count,
    settled.asking_sample_count,
  );
  assert.ok(recomputes() <= 1, `a replay recomputes at most once: ${recomputes()}`);
});

test("a failed page advances neither the samples nor the cursor", async () => {
  // The deferral must not weaken the all-or-nothing property the cursor rests on.
  const { sqlite, db } = backfillFixture();
  listingWithRetainedHistory(sqlite, "deep", 30);
  const killed = new Proxy(db, {
    get(target, property) {
      if (property !== "batch") return Reflect.get(target, property);
      return async () => {
        throw new Error("isolate killed before the commit landed");
      };
    },
  });

  await assert.rejects(
    backfillKnowledgeCatalogPriceIndex(killed, { backfillKey: "killed", batchSize: 30 }),
    /isolate killed/u,
  );

  assert.equal(sampleCount(sqlite), 0);
  assert.equal(
    Number(
      (
        sqlite
          .prepare(
            "SELECT after_price_history_id AS id FROM knowledge_catalog_price_index_backfill_runs WHERE backfill_key = ?",
          )
          .get("killed") as { id: number }
      ).id,
    ),
    0,
    "the cursor stayed where it was",
  );
  const open = sqlite
    .prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_price_index_refresh_deferrals")
    .get() as { n: number };
  assert.equal(Number(open.n), 0, "and no deferral was left open for the next writer");
});
