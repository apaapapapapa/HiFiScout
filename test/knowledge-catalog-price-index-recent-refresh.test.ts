import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import {
  backfillRecentPriceIndexes,
  refreshExpiredRecentPriceIndexes,
} from "../src/db/knowledge-catalog-price-index-recent-refresh.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { queryPlan, readsThroughIndex, recordingDatabase } from "./helpers/query-plan.js";

const BACKFILL_KEY = "recent-price-index-v1";

function emptyPriceIndex() {
  const database = migratedSqlite();
  database.sqlite.exec(`
    DELETE FROM knowledge_catalog_price_index_samples;
    DELETE FROM knowledge_catalog_price_index_recent_refreshes;
    DELETE FROM knowledge_catalog_price_indexes;
    DELETE FROM knowledge_catalog_products;
    UPDATE knowledge_catalog_price_index_recent_backfill_runs
    SET after_catalog_product_id = 0,
        status = 'running',
        updated_at = '2026-09-04T00:00:00.000Z',
        completed_at = NULL
    WHERE backfill_key = '${BACKFILL_KEY}';
  `);
  return database;
}

function insertCatalogProduct(sqlite: DatabaseSync, id: number): void {
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_products(
        id, manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at
      ) VALUES (?, 'luxman', ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    .run(id, `M-${id}`, `m-${id}`, `Luxman M-${id}`);
}

let eventId = 0;

function insertAskingSample(
  sqlite: DatabaseSync,
  catalogProductId: number,
  priceYen: number,
  observedAt = "2026-09-01T00:00:00.000Z",
): void {
  eventId += 1;
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_price_index_samples(
        event_key, catalog_product_id, listing_product_id, shop_key, source_id,
        sample_kind, signal_kind, price_yen, observed_at
      ) VALUES (?, ?, ?, 'shop', ?, 'asking', 'asking', ?, ?)
    `)
    .run(
      `recent-refresh-${eventId}`,
      catalogProductId,
      eventId,
      `source-${eventId}`,
      priceYen,
      observedAt,
    );
}

function seedProducts(sqlite: DatabaseSync, count: number): void {
  sqlite.exec("BEGIN");
  for (let id = 1; id <= count; id += 1) {
    insertCatalogProduct(sqlite, id);
    insertAskingSample(sqlite, id, id * 1000 + 100);
    insertAskingSample(sqlite, id, id * 1000 + 200);
    insertAskingSample(sqlite, id, id * 1000 + 300);
  }
  sqlite.exec(`
    UPDATE knowledge_catalog_price_indexes SET recent_asking_median_yen = -1;
    DELETE FROM knowledge_catalog_price_index_recent_refreshes;
    COMMIT;
  `);
}

test("recent median backfill is bounded, resumable, and retry-idempotent", async () => {
  const { sqlite, db } = emptyPriceIndex();
  seedProducts(sqlite, 52);
  const now = new Date("2026-09-04T00:00:00.000Z");
  const recording = recordingDatabase(db);

  const first = await backfillRecentPriceIndexes(recording.db, { now });
  assert.deepEqual(first, {
    status: "running",
    selectedCount: 25,
    refreshedCount: 25,
    afterCatalogProductId: 25,
    hasMore: true,
  });
  assert.equal(
    recording.executed.length,
    53,
    "one full page is two selectors, 50 product-scoped writes, and one cursor write",
  );
  const candidateSelector = recording.executed.find((statement) =>
    /FROM knowledge_catalog_price_indexes\s+WHERE catalog_product_id > \?/u.test(statement.sql),
  );
  assert.ok(candidateSelector);
  assert.ok(
    queryPlan(sqlite, candidateSelector).some((step) =>
      step.detail.startsWith("SEARCH knowledge_catalog_price_indexes USING INTEGER PRIMARY KEY"),
    ),
  );
  for (const statement of recording.executed.filter((candidate) =>
    /FROM knowledge_catalog_price_index_samples/u.test(candidate.sql),
  )) {
    assert.equal(
      readsThroughIndex(
        queryPlan(sqlite, statement),
        "knowledge_catalog_price_index_samples",
        "idx_knowledge_catalog_price_index_samples_catalog",
      ),
      true,
    );
  }
  assert.equal(
    Number(
      (
        sqlite
          .prepare(`
            SELECT COUNT(*) AS count
            FROM knowledge_catalog_price_indexes
            WHERE recent_asking_median_yen <> -1
          `)
          .get() as { count: number }
      ).count,
    ),
    25,
  );

  const second = await backfillRecentPriceIndexes(db, { now });
  assert.equal(second.selectedCount, 25);
  assert.equal(second.afterCatalogProductId, 50);
  assert.equal(second.status, "running");

  const third = await backfillRecentPriceIndexes(db, { now });
  assert.deepEqual(third, {
    status: "completed",
    selectedCount: 2,
    refreshedCount: 2,
    afterCatalogProductId: 52,
    hasMore: false,
  });
  assert.deepEqual(
    {
      ...sqlite
        .prepare(`
          SELECT after_catalog_product_id, status, completed_at
          FROM knowledge_catalog_price_index_recent_backfill_runs
          WHERE backfill_key = ?
        `)
        .get(BACKFILL_KEY),
    },
    {
      after_catalog_product_id: 52,
      status: "completed",
      completed_at: now.toISOString(),
    },
  );
  assert.equal(
    Number(
      (
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_recent_refreshes")
          .get() as { count: number }
      ).count,
    ),
    52,
  );

  const retry = await backfillRecentPriceIndexes(db, { now });
  assert.deepEqual(retry, {
    status: "completed",
    selectedCount: 0,
    refreshedCount: 0,
    afterCatalogProductId: 52,
    hasMore: false,
  });
  await assert.rejects(backfillRecentPriceIndexes(db, { limit: 26 }), /must be in \[1, 25\]/u);
  sqlite.close();
});

test("a failed cursor advance rolls back its projection page", async () => {
  const { sqlite, db } = emptyPriceIndex();
  seedProducts(sqlite, 1);
  sqlite.exec(`
    CREATE TRIGGER reject_recent_price_index_cursor
    BEFORE UPDATE ON knowledge_catalog_price_index_recent_backfill_runs
    WHEN NEW.after_catalog_product_id > OLD.after_catalog_product_id
    BEGIN
      SELECT RAISE(ABORT, 'recent cursor blocked');
    END;
  `);

  await assert.rejects(
    backfillRecentPriceIndexes(db, { now: new Date("2026-09-04T00:00:00.000Z") }),
    /recent cursor blocked/u,
  );
  assert.equal(
    Number(
      (
        sqlite
          .prepare(`
            SELECT recent_asking_median_yen
            FROM knowledge_catalog_price_indexes
            WHERE catalog_product_id = 1
          `)
          .get() as { recent_asking_median_yen: number }
      ).recent_asking_median_yen,
    ),
    -1,
    "median write must roll back with the cursor update",
  );
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_recent_refreshes")
      .get()?.count,
    0,
  );
  sqlite.close();
});

test("expiry refresh is strict at the boundary and idempotent after repair", async () => {
  const { sqlite, db } = emptyPriceIndex();
  insertCatalogProduct(sqlite, 1);
  insertAskingSample(sqlite, 1, 100000, "2026-06-06T00:00:00.000Z");
  insertAskingSample(sqlite, 1, 300000, "2026-06-07T00:00:00.000Z");
  sqlite.exec(`
    UPDATE knowledge_catalog_price_indexes SET recent_asking_median_yen = -1;
    UPDATE knowledge_catalog_price_index_recent_refreshes
    SET next_expiry_at = '2026-09-04T00:00:00.000Z';
  `);

  const atBoundary = await refreshExpiredRecentPriceIndexes(db, {
    now: new Date("2026-09-04T00:00:00.000Z"),
  });
  assert.equal(atBoundary.selectedCount, 0, "the inclusive window retains its boundary sample");

  const refreshed = await refreshExpiredRecentPriceIndexes(db, {
    now: new Date("2026-09-04T00:00:00.001Z"),
  });
  assert.deepEqual(refreshed, { selectedCount: 1, refreshedCount: 1, hasMore: false });
  assert.deepEqual(
    {
      ...sqlite
        .prepare(`
          SELECT i.recent_asking_median_yen, r.next_expiry_at
          FROM knowledge_catalog_price_indexes i
          JOIN knowledge_catalog_price_index_recent_refreshes r
            ON r.catalog_product_id = i.catalog_product_id
          WHERE i.catalog_product_id = 1
        `)
        .get(),
    },
    {
      recent_asking_median_yen: 300000,
      next_expiry_at: "2026-09-05T00:00:00.000Z",
    },
  );

  const retry = await refreshExpiredRecentPriceIndexes(db, {
    now: new Date("2026-09-04T00:00:00.001Z"),
  });
  assert.deepEqual(retry, { selectedCount: 0, refreshedCount: 0, hasMore: false });
  sqlite.close();
});

test("catalog-product deletion cascades without recreating refresh state", () => {
  const { sqlite } = emptyPriceIndex();
  insertCatalogProduct(sqlite, 1);
  insertAskingSample(sqlite, 1, 100000);
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_recent_refreshes")
      .get()?.count,
    1,
  );

  sqlite.prepare("DELETE FROM knowledge_catalog_products WHERE id = 1").run();

  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_samples").get()
      ?.count,
    0,
  );
  assert.equal(
    sqlite
      .prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_price_index_recent_refreshes")
      .get()?.count,
    0,
    "the sample cascade must not recreate a child row for the deleting catalog product",
  );
  sqlite.close();
});
