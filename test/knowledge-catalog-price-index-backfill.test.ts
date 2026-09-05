import { createPreMigrationDatabase } from "./helpers/price-index.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { backfillKnowledgeCatalogPriceIndex } from "../src/db/knowledge-catalog-price-index-backfill.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

const priceIndexMigrationSql = readFileSync(
  new URL("../migrations/0060_knowledge_catalog_price_index.sql", import.meta.url),
  "utf8",
);
const backfillMigrationSql = readFileSync(
  new URL("../migrations/0061_knowledge_catalog_price_index_backfill.sql", import.meta.url),
  "utf8",
);

function insertCatalogProduct(db: DatabaseSync, model: string): number {
  return Number(
    db
      .prepare(`
        INSERT INTO knowledge_catalog_products(
          manufacturer_id, canonical_model, normalized_model, created_at, updated_at
        ) VALUES ('tad', ?, lower(?), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `)
      .run(model, model).lastInsertRowid,
  );
}

function insertListing(db: DatabaseSync, sourceId: string, priceYen: number): number {
  return Number(
    db
      .prepare(`
        INSERT INTO products(shop_key, source_id, price_yen, stock_status, last_seen_at, is_active)
        VALUES ('hifido', ?, ?, 'in_stock', '2026-08-27T00:00:00.000Z', 1)
      `)
      .run(sourceId, priceYen).lastInsertRowid,
  );
}

function insertHistory(db: DatabaseSync, listingProductId: number, priceYen: number): number {
  return Number(
    db
      .prepare(`
        INSERT INTO price_history(product_id, price_yen, observed_at)
        VALUES (?, ?, '2026-08-27T00:00:00.000Z')
      `)
      .run(listingProductId, priceYen).lastInsertRowid,
  );
}

function sampleCount(db: DatabaseSync): number {
  return Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_samples").get() as {
        count: number;
      }
    ).count,
  );
}

test("price-index backfill is bounded, resumable, and coexists with live incremental writes", async () => {
  const db = createPreMigrationDatabase();
  const catalogProductId = insertCatalogProduct(db, "D1000TX");
  const listingProductId = insertListing(db, "matched", 300);
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, ?, 'matched')
  `).run(listingProductId, catalogProductId);
  insertHistory(db, listingProductId, 100);
  const secondHistoryId = insertHistory(db, listingProductId, 200);
  insertHistory(db, listingProductId, 300);

  db.exec(priceIndexMigrationSql);
  db.exec(backfillMigrationSql);
  // Simulate a ledger that needs repair while retaining the source history.
  db.exec("DELETE FROM knowledge_catalog_price_index_samples;");

  const database = sqliteD1(db);
  const first = await backfillKnowledgeCatalogPriceIndex(database, {
    backfillKey: "test-resume",
    batchSize: 2,
    now: new Date("2026-08-27T01:00:00.000Z"),
  });
  assert.deepEqual(first, {
    event: "knowledge_catalog_price_index_backfill",
    backfillKey: "test-resume",
    status: "running",
    selectedCount: 2,
    writtenCount: 2,
    afterPriceHistoryId: secondHistoryId,
    hasMore: true,
  });
  assert.equal(sampleCount(db), 2);

  // The normal price_history trigger keeps accepting live data while historical backfill runs.
  const liveHistoryId = insertHistory(db, listingProductId, 400);
  assert.equal(sampleCount(db), 3);

  // An unresolved row can be passed by the keyset cursor without becoming a permanent hole: the
  // existing identity-resolution trigger owns the later transition into the price index.
  const unresolvedListingId = insertListing(db, "unresolved", 500);
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, NULL, 'unresolved')
  `).run(unresolvedListingId);
  const unresolvedHistoryId = insertHistory(db, unresolvedListingId, 500);

  const second = await backfillKnowledgeCatalogPriceIndex(database, {
    backfillKey: "test-resume",
    batchSize: 2,
    now: new Date("2026-08-27T01:01:00.000Z"),
  });
  assert.equal(second.status, "completed");
  assert.equal(second.selectedCount, 2);
  assert.equal(second.writtenCount, 1, "live sample must be an idempotent no-op during backfill");
  assert.equal(second.afterPriceHistoryId, liveHistoryId);
  assert.equal(second.hasMore, false);
  assert.equal(sampleCount(db), 4);

  const state = db
    .prepare(`
      SELECT after_price_history_id, status, completed_at
      FROM knowledge_catalog_price_index_backfill_runs
      WHERE backfill_key = 'test-resume'
    `)
    .get() as {
    after_price_history_id: number;
    status: string;
    completed_at: string | null;
  };
  assert.equal(state.after_price_history_id, liveHistoryId);
  assert.equal(state.status, "completed");
  assert.equal(state.completed_at, "2026-08-27T01:01:00.000Z");

  db.prepare(`
    UPDATE product_identity_resolutions
    SET catalog_product_id = ?, status = 'matched'
    WHERE listing_product_id = ?
  `).run(catalogProductId, unresolvedListingId);
  assert.equal(sampleCount(db), 5);
  assert.equal(
    Number(
      (
        db
          .prepare(`
            SELECT COUNT(*) AS count
            FROM knowledge_catalog_price_index_samples
            WHERE source_price_history_id = ?
          `)
          .get(unresolvedHistoryId) as { count: number }
      ).count,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        db
          .prepare(`
            SELECT asking_sample_count
            FROM knowledge_catalog_price_indexes
            WHERE catalog_product_id = ?
          `)
          .get(catalogProductId) as { asking_sample_count: number }
      ).asking_sample_count,
    ),
    5,
  );

  const completedRetry = await backfillKnowledgeCatalogPriceIndex(database, {
    backfillKey: "test-resume",
    batchSize: 2,
  });
  assert.equal(completedRetry.selectedCount, 0);
  assert.equal(completedRetry.writtenCount, 0);
  assert.equal(completedRetry.hasMore, false);
  assert.equal(sampleCount(db), 5);

  db.close();
});

test("price-index sample writes roll back when the persisted cursor cannot advance", async () => {
  const db = createPreMigrationDatabase();
  const catalogProductId = insertCatalogProduct(db, "ME1TX");
  const listingProductId = insertListing(db, "atomic", 700);
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, ?, 'matched')
  `).run(listingProductId, catalogProductId);
  const historyId = insertHistory(db, listingProductId, 700);
  db.exec(priceIndexMigrationSql);
  db.exec(backfillMigrationSql);
  db.exec("DELETE FROM knowledge_catalog_price_index_samples;");
  db.exec(`
    CREATE TRIGGER reject_price_index_backfill_cursor
    BEFORE UPDATE ON knowledge_catalog_price_index_backfill_runs
    WHEN NEW.after_price_history_id > OLD.after_price_history_id
    BEGIN
      SELECT RAISE(ABORT, 'cursor update blocked');
    END;
  `);

  const database = sqliteD1(db);
  await assert.rejects(
    backfillKnowledgeCatalogPriceIndex(database, {
      backfillKey: "test-atomic",
      batchSize: 1,
    }),
    /cursor update blocked/,
  );
  assert.equal(sampleCount(db), 0, "sample insert must roll back with the failed cursor update");
  const failedState = db
    .prepare(`
      SELECT after_price_history_id, status
      FROM knowledge_catalog_price_index_backfill_runs
      WHERE backfill_key = 'test-atomic'
    `)
    .get() as { after_price_history_id: number; status: string };
  assert.equal(failedState.after_price_history_id, 0);
  assert.equal(failedState.status, "running");

  db.exec("DROP TRIGGER reject_price_index_backfill_cursor;");
  const retry = await backfillKnowledgeCatalogPriceIndex(database, {
    backfillKey: "test-atomic",
    batchSize: 1,
  });
  assert.equal(retry.status, "completed");
  assert.equal(retry.afterPriceHistoryId, historyId);
  assert.equal(retry.writtenCount, 1);
  assert.equal(sampleCount(db), 1);

  db.close();
});
