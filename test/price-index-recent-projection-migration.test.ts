import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

const migration = readFileSync(
  new URL("../migrations/0078_price_index_recent_projection.sql", import.meta.url),
  "utf8",
);

function preMigrationDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE knowledge_catalog_products (id INTEGER PRIMARY KEY);
    CREATE TABLE knowledge_catalog_price_index_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_product_id INTEGER NOT NULL,
      sample_kind TEXT NOT NULL,
      price_yen INTEGER,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE knowledge_catalog_price_indexes (
      catalog_product_id INTEGER PRIMARY KEY,
      recent_asking_median_yen INTEGER,
      last_computed_at TEXT NOT NULL
    );
    INSERT INTO knowledge_catalog_products(id) VALUES (1);
    INSERT INTO knowledge_catalog_price_index_samples(
      catalog_product_id, sample_kind, price_yen, observed_at
    ) VALUES (1, 'asking', 100000, '2026-01-01T00:00:00.000Z');
    INSERT INTO knowledge_catalog_price_indexes(
      catalog_product_id, recent_asking_median_yen, last_computed_at
    ) VALUES (1, 123456, '2026-01-02T00:00:00.000Z');
  `);
  return sqlite;
}

test("migration 0078 creates state without running a history-sized rebuild", () => {
  const triggerBoundary = migration.indexOf("CREATE TRIGGER");
  assert.ok(triggerBoundary > 0, "migration should install incremental maintenance triggers");
  const preTriggerSql = migration
    .slice(0, triggerBoundary)
    .replace(/^--.*$/gmu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "");

  assert.doesNotMatch(preTriggerSql, /ROW_NUMBER\s*\(/iu);
  assert.doesNotMatch(preTriggerSql, /COUNT\s*\(\s*\*\s*\)\s*OVER/iu);
  assert.doesNotMatch(preTriggerSql, /GROUP\s+BY/iu);
  assert.doesNotMatch(preTriggerSql, /UPDATE\s+knowledge_catalog_price_indexes/iu);
  assert.doesNotMatch(preTriggerSql, /FROM\s+knowledge_catalog_price_index_samples/iu);

  const sqlite = preMigrationDatabase();
  sqlite.exec(migration);

  assert.deepEqual(
    {
      ...sqlite
        .prepare(`
          SELECT recent_asking_median_yen, last_computed_at
          FROM knowledge_catalog_price_indexes
        `)
        .get(),
    },
    { recent_asking_median_yen: 123456, last_computed_at: "2026-01-02T00:00:00.000Z" },
    "deploy migration must leave existing projections untouched for the bounded worker",
  );
  assert.deepEqual(
    {
      ...sqlite
        .prepare(`
          SELECT backfill_key, after_catalog_product_id, status
          FROM knowledge_catalog_price_index_recent_backfill_runs
        `)
        .get(),
    },
    {
      backfill_key: "recent-price-index-v1",
      after_catalog_product_id: 0,
      status: "running",
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
    0,
    "migration must not enumerate existing products into refresh state",
  );
  sqlite.close();
});
