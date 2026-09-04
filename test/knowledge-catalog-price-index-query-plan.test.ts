import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import { loadKnowledgeCatalogPriceIndexes } from "../src/db/knowledge-catalog-price-index-read.js";
import { refreshExpiredRecentPriceIndexes } from "../src/db/knowledge-catalog-price-index-recent-refresh.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { queryPlan, readsThroughIndex, recordingDatabase } from "./helpers/query-plan.js";

const NOW = new Date("2026-09-04T00:00:00.000Z");
const SAMPLE_INDEX = "idx_knowledge_catalog_price_index_samples_catalog";

function resetPriceIndex(sqlite: DatabaseSync): void {
  sqlite.exec(`
    DELETE FROM knowledge_catalog_price_index_samples;
    DELETE FROM knowledge_catalog_price_index_recent_refreshes;
    DELETE FROM knowledge_catalog_price_indexes;
    DELETE FROM knowledge_catalog_products;
    DROP TRIGGER IF EXISTS trg_price_index_sample_insert;
    DROP TRIGGER IF EXISTS trg_price_index_sample_delete;
    DROP TRIGGER IF EXISTS trg_price_index_sample_update;
    DROP TRIGGER IF EXISTS trg_price_index_recent_refresh_insert;
    DROP TRIGGER IF EXISTS trg_price_index_recent_refresh_update;
    DROP TRIGGER IF EXISTS trg_price_index_recent_refresh_delete;
  `);
}

function insertProducts(sqlite: DatabaseSync, first: number, last: number): void {
  const product = sqlite.prepare(`
    INSERT INTO knowledge_catalog_products(
      id, manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at
    ) VALUES (?, 'luxman', ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `);
  const projection = sqlite.prepare(`
    INSERT INTO knowledge_catalog_price_indexes(
      catalog_product_id, asking_sample_count, asking_median_yen, asking_min_yen,
      asking_max_yen, recent_asking_median_yen, listing_end_sample_count,
      listing_end_median_yen, sold_out_signal_count, deactivated_signal_count,
      last_computed_at
    ) VALUES (?, 3, 200000, 100000, 300000, 200000, 0, NULL, 0, 0,
              '2026-09-01T00:00:00.000Z')
  `);
  sqlite.exec("BEGIN");
  for (let id = first; id <= last; id += 1) {
    product.run(id, `M-${id}`, `m-${id}`, `Luxman M-${id}`);
    projection.run(id);
  }
  sqlite.exec("COMMIT");
}

let nextSampleId = 0;

function insertSamples(
  sqlite: DatabaseSync,
  count: number,
  catalogProductIds: readonly number[],
): void {
  const sample = sqlite.prepare(`
    INSERT INTO knowledge_catalog_price_index_samples(
      event_key, catalog_product_id, listing_product_id, shop_key, source_id,
      sample_kind, signal_kind, price_yen, observed_at
    ) VALUES (?, ?, ?, 'shop', ?, 'asking', 'asking', ?, '2026-09-01T00:00:00.000Z')
  `);
  sqlite.exec("BEGIN");
  for (let index = 0; index < count; index += 1) {
    nextSampleId += 1;
    const catalogProductId = catalogProductIds[index % catalogProductIds.length] || 1;
    sample.run(
      `query-plan-${nextSampleId}`,
      catalogProductId,
      nextSampleId,
      `source-${nextSampleId}`,
      100000 + (nextSampleId % 1000),
    );
  }
  sqlite.exec("COMMIT");
}

function scheduleTwoDueProducts(sqlite: DatabaseSync, productCount: number): void {
  const insert = sqlite.prepare(`
    INSERT INTO knowledge_catalog_price_index_recent_refreshes(
      catalog_product_id, next_expiry_at, updated_at
    ) VALUES (?, ?, '2026-09-04T00:00:00.000Z')
  `);
  sqlite.exec("DELETE FROM knowledge_catalog_price_index_recent_refreshes; BEGIN");
  for (let id = 1; id <= productCount; id += 1) {
    insert.run(id, id <= 2 ? "2026-09-03T00:00:00.000Z" : "2026-12-01T00:00:00.000Z");
  }
  sqlite.exec("COMMIT");
}

async function publicReadObservation(
  sqlite: DatabaseSync,
  db: ReturnType<typeof migratedSqlite>["db"],
  catalogProductIds: readonly number[],
) {
  const recording = recordingDatabase(db);
  const summaries = await loadKnowledgeCatalogPriceIndexes(recording.db, catalogProductIds);
  for (const statement of recording.executed) {
    const plan = queryPlan(sqlite, statement);
    assert.equal(
      plan.some((step) => step.detail.includes("knowledge_catalog_price_index_samples")),
      false,
      `public plan must not reach sample history: ${JSON.stringify(plan)}`,
    );
    assert.ok(
      plan.some((step) =>
        step.detail.startsWith("SEARCH knowledge_catalog_price_indexes USING INTEGER PRIMARY KEY"),
      ),
      `projection lookup should use its primary key: ${JSON.stringify(plan)}`,
    );
  }
  return { summaries: summaries.size, statements: recording.executed.length };
}

async function expiryObservation(
  sqlite: DatabaseSync,
  db: ReturnType<typeof migratedSqlite>["db"],
) {
  const recording = recordingDatabase(db);
  const result = await refreshExpiredRecentPriceIndexes(recording.db, { now: NOW });
  const dueSelector = recording.executed.find((statement) =>
    /FROM knowledge_catalog_price_index_recent_refreshes/u.test(statement.sql),
  );
  assert.ok(dueSelector);
  assert.equal(
    readsThroughIndex(
      queryPlan(sqlite, dueSelector),
      "knowledge_catalog_price_index_recent_refreshes",
      "idx_price_index_recent_refresh_due",
    ),
    true,
  );

  const historyStatements = recording.executed.filter((statement) =>
    /FROM knowledge_catalog_price_index_samples/u.test(statement.sql),
  );
  assert.equal(historyStatements.length, 4, "two due products issue two scoped history reads each");
  for (const statement of historyStatements) {
    assert.ok(
      [1, 2].includes(Number(statement.binds[0])),
      "only due product ids may reach history",
    );
    assert.equal(
      readsThroughIndex(
        queryPlan(sqlite, statement),
        "knowledge_catalog_price_index_samples",
        SAMPLE_INDEX,
      ),
      true,
      `due history read should be product-indexed: ${JSON.stringify(queryPlan(sqlite, statement))}`,
    );
  }
  return {
    selected: result.selectedCount,
    refreshed: result.refreshedCount,
    statements: recording.executed.length,
    historyStatements: historyStatements.length,
  };
}

test("an empty due queue never reads price-index sample history", async () => {
  const { sqlite, db } = migratedSqlite();
  resetPriceIndex(sqlite);
  const recording = recordingDatabase(db);

  const result = await refreshExpiredRecentPriceIndexes(recording.db, { now: NOW });

  assert.deepEqual(result, { selectedCount: 0, refreshedCount: 0, hasMore: false });
  assert.equal(recording.executed.length, 1, "only the partial-index due selector should run");
  const selector = recording.executed[0]?.sql || "";
  assert.match(
    selector,
    /WHERE next_expiry_at < \?\s+ORDER BY next_expiry_at ASC, catalog_product_id ASC\s+LIMIT \?/u,
  );
  assert.doesNotMatch(selector, /knowledge_catalog_price_index_samples/u);
  sqlite.close();
});

test("public reads stay projection-sized when sample history grows from 10k to 100k", async () => {
  const { sqlite, db } = migratedSqlite();
  resetPriceIndex(sqlite);
  insertProducts(sqlite, 1, 10);
  insertSamples(sqlite, 6, [1, 2]);
  insertSamples(sqlite, 9994, [3, 4, 5, 6, 7, 8, 9, 10]);

  const tenProductsAtTenThousandSamples = await publicReadObservation(
    sqlite,
    db,
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  scheduleTwoDueProducts(sqlite, 10);
  const refreshAtTenThousandSamples = await expiryObservation(sqlite, db);

  insertProducts(sqlite, 11, 100);
  insertSamples(
    sqlite,
    90000,
    Array.from({ length: 98 }, (_, index) => index + 3),
  );
  const tenProductsAtOneHundredThousandSamples = await publicReadObservation(
    sqlite,
    db,
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  const oneHundredProductsAtOneHundredThousandSamples = await publicReadObservation(
    sqlite,
    db,
    Array.from({ length: 100 }, (_, index) => index + 1),
  );
  scheduleTwoDueProducts(sqlite, 100);
  const refreshAtOneHundredThousandSamples = await expiryObservation(sqlite, db);

  assert.deepEqual(tenProductsAtTenThousandSamples, { summaries: 10, statements: 1 });
  assert.deepEqual(
    tenProductsAtOneHundredThousandSamples,
    tenProductsAtTenThousandSamples,
    "tenfold history growth must not change public read cardinality",
  );
  assert.deepEqual(oneHundredProductsAtOneHundredThousandSamples, {
    summaries: 100,
    statements: 2,
  });
  assert.deepEqual(refreshAtTenThousandSamples, {
    selected: 2,
    refreshed: 2,
    statements: 5,
    historyStatements: 4,
  });
  assert.deepEqual(
    refreshAtOneHundredThousandSamples,
    refreshAtTenThousandSamples,
    "non-due sample history must not add refresh statements or selected products",
  );
  sqlite.close();
});
