import { createPreMigrationDatabase } from "./helpers/price-index.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

const migrationSql = readFileSync(
  new URL("../migrations/0060_knowledge_catalog_price_index.sql", import.meta.url),
  "utf8",
);
const triggerUpsertMigrationSql = readFileSync(
  new URL("../migrations/0070_price_index_trigger_upsert.sql", import.meta.url),
  "utf8",
);

type IndexRow = {
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
  last_computed_at: string;
};

function insertCatalogProduct(db: DatabaseSync, model: string): number {
  const result = db
    .prepare(`
      INSERT INTO knowledge_catalog_products(
        manufacturer_id, canonical_model, normalized_model, created_at, updated_at
      ) VALUES ('tad', ?, lower(?), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    .run(model, model);
  return Number(result.lastInsertRowid);
}

function insertListing(db: DatabaseSync, sourceId: string, priceYen: number): number {
  const result = db
    .prepare(`
      INSERT INTO products(shop_key, source_id, price_yen, stock_status, last_seen_at, is_active)
      VALUES ('hifido', ?, ?, 'in_stock', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), 1)
    `)
    .run(sourceId, priceYen);
  return Number(result.lastInsertRowid);
}

function getIndex(db: DatabaseSync, catalogProductId: number): IndexRow | undefined {
  return db
    .prepare(`
      SELECT catalog_product_id, asking_sample_count, asking_median_yen,
             asking_min_yen, asking_max_yen, recent_asking_median_yen,
             listing_end_sample_count, listing_end_median_yen,
             sold_out_signal_count, deactivated_signal_count, last_computed_at
      FROM knowledge_catalog_price_indexes
      WHERE catalog_product_id = ?
    `)
    .get(catalogProductId) as IndexRow | undefined;
}

test("price-index migration backfills lifetime and recent asking aggregates", () => {
  const db = createPreMigrationDatabase();
  const catalogProductId = insertCatalogProduct(db, "D1000");
  const listingProductId = insertListing(db, "p1", 300);
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, ?, 'matched')
  `).run(listingProductId, catalogProductId);
  db.prepare(`
    INSERT INTO price_history(product_id, price_yen, observed_at)
    VALUES (?, 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-120 days'))
  `).run(listingProductId);
  db.prepare(`
    INSERT INTO price_history(product_id, price_yen, observed_at)
    VALUES (?, 300, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days'))
  `).run(listingProductId);

  db.exec(migrationSql);

  const row = getIndex(db, catalogProductId);
  assert.ok(row);
  assert.equal(row.asking_sample_count, 2);
  assert.equal(row.asking_median_yen, 200);
  assert.equal(row.asking_min_yen, 100);
  assert.equal(row.asking_max_yen, 300);
  assert.equal(row.recent_asking_median_yen, 300);
  assert.equal(row.listing_end_sample_count, 0);
  assert.equal(row.listing_end_median_yen, null);
  assert.equal(row.sold_out_signal_count, 0);
  assert.equal(row.deactivated_signal_count, 0);
  assert.match(row.last_computed_at, /^\d{4}-\d{2}-\d{2}T/);

  db.close();
});

test("price changes and listing ends update incrementally and survive listing retention", () => {
  const db = createPreMigrationDatabase();
  db.exec(migrationSql);
  const catalogProductId = insertCatalogProduct(db, "ME1TX");
  const listingProductId = insertListing(db, "p2", 100);
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, ?, 'matched')
  `).run(listingProductId, catalogProductId);

  for (const price of [100, 300, 500]) {
    db.prepare(`
      INSERT INTO price_history(product_id, price_yen, observed_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(listingProductId, price);
  }

  let row = getIndex(db, catalogProductId);
  assert.ok(row);
  assert.equal(row.asking_sample_count, 3);
  assert.equal(row.asking_median_yen, 300);
  assert.equal(row.asking_min_yen, 100);
  assert.equal(row.asking_max_yen, 500);
  assert.equal(row.recent_asking_median_yen, 300);

  db.prepare("UPDATE products SET price_yen = 500, stock_status = 'sold_out' WHERE id = ?").run(
    listingProductId,
  );
  db.prepare("UPDATE products SET is_active = 0 WHERE id = ?").run(listingProductId);

  row = getIndex(db, catalogProductId);
  assert.ok(row);
  assert.equal(row.listing_end_sample_count, 1);
  assert.equal(row.listing_end_median_yen, 500);
  assert.equal(row.sold_out_signal_count, 1);
  assert.equal(row.deactivated_signal_count, 0);

  // A retry of the same deactivation is a no-op because 0 -> 0 is not a new listing end.
  db.prepare("UPDATE products SET is_active = 0 WHERE id = ?").run(listingProductId);
  assert.equal(
    Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_samples WHERE sample_kind = 'listing_end'",
          )
          .get() as { count: number }
      ).count,
    ),
    1,
  );

  // A later reactivation gets a new last_seen_at and can legitimately produce another end event.
  db.prepare(`
    UPDATE products
    SET is_active = 1,
        stock_status = 'in_stock',
        last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 second')
    WHERE id = ?
  `).run(listingProductId);
  db.prepare("UPDATE products SET is_active = 0 WHERE id = ?").run(listingProductId);

  row = getIndex(db, catalogProductId);
  assert.ok(row);
  assert.equal(row.listing_end_sample_count, 2);
  assert.equal(row.listing_end_median_yen, 500);
  assert.equal(row.sold_out_signal_count, 1);
  assert.equal(row.deactivated_signal_count, 1);

  // Current retention removes price_history/products. The price-index ledger deliberately has
  // no foreign key to either table, so both evidence and aggregate remain intact.
  db.prepare("DELETE FROM price_history WHERE product_id = ?").run(listingProductId);
  db.prepare("DELETE FROM products WHERE id = ?").run(listingProductId);

  assert.equal(
    Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_samples").get() as {
          count: number;
        }
      ).count,
    ),
    5,
  );
  row = getIndex(db, catalogProductId);
  assert.ok(row);
  assert.equal(row.asking_sample_count, 3);
  assert.equal(row.listing_end_sample_count, 2);
  assert.equal(row.sold_out_signal_count, 1);
  assert.equal(row.deactivated_signal_count, 1);

  db.close();
});

test("late identity resolution backfills samples and matched reassignment moves them", () => {
  const db = createPreMigrationDatabase();
  db.exec(migrationSql);
  const firstCatalogProductId = insertCatalogProduct(db, "P1");
  const secondCatalogProductId = insertCatalogProduct(db, "P1X");
  const listingProductId = insertListing(db, "p3", 700);

  db.prepare(`
    INSERT INTO price_history(product_id, price_yen, observed_at)
    VALUES (?, 700, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(listingProductId);
  assert.equal(
    Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_samples").get() as {
          count: number;
        }
      ).count,
    ),
    0,
  );

  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, ?, 'matched')
  `).run(listingProductId, firstCatalogProductId);
  assert.equal(getIndex(db, firstCatalogProductId)?.asking_median_yen, 700);

  db.prepare(`
    UPDATE product_identity_resolutions
    SET catalog_product_id = ?, status = 'matched'
    WHERE listing_product_id = ?
  `).run(secondCatalogProductId, listingProductId);

  assert.equal(getIndex(db, firstCatalogProductId), undefined);
  assert.equal(getIndex(db, secondCatalogProductId)?.asking_median_yen, 700);
  assert.equal(
    Number(
      (
        db
          .prepare(`
            SELECT catalog_product_id
            FROM knowledge_catalog_price_index_samples
            WHERE listing_product_id = ?
          `)
          .get(listingProductId) as { catalog_product_id: number }
      ).catalog_product_id,
    ),
    secondCatalogProductId,
  );

  // An explicit unmatch removes an attribution; retention deletion is the path that preserves it.
  db.prepare(`
    UPDATE product_identity_resolutions
    SET catalog_product_id = NULL, status = 'unresolved'
    WHERE listing_product_id = ?
  `).run(listingProductId);
  assert.equal(getIndex(db, secondCatalogProductId), undefined);
  assert.equal(
    Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_samples").get() as {
          count: number;
        }
      ).count,
    ),
    0,
  );

  db.close();
});

test("identity UPSERT adds evidence to an existing catalog price index", () => {
  const db = createPreMigrationDatabase();
  db.exec(migrationSql);
  db.exec(triggerUpsertMigrationSql);
  const catalogProductId = insertCatalogProduct(db, "C-2");

  const existingListingId = insertListing(db, "existing-index", 100);
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, ?, 'matched')
  `).run(existingListingId, catalogProductId);
  db.prepare(`
    INSERT INTO price_history(product_id, price_yen, observed_at)
    VALUES (?, 100, '2026-09-01T00:00:00.000Z')
  `).run(existingListingId);
  assert.equal(getIndex(db, catalogProductId)?.asking_sample_count, 1);

  const replayedListingId = insertListing(db, "identity-upsert", 200);
  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, NULL, 'unresolved')
  `).run(replayedListingId);
  db.prepare(`
    INSERT INTO price_history(product_id, price_yen, observed_at)
    VALUES (?, 200, '2026-09-01T00:01:00.000Z')
  `).run(replayedListingId);

  db.prepare(`
    INSERT INTO product_identity_resolutions(listing_product_id, catalog_product_id, status)
    VALUES (?, ?, 'matched')
    ON CONFLICT(listing_product_id) DO UPDATE SET
      catalog_product_id = excluded.catalog_product_id,
      status = excluded.status
  `).run(replayedListingId, catalogProductId);

  assert.equal(getIndex(db, catalogProductId)?.asking_sample_count, 2);
  db.close();
});
