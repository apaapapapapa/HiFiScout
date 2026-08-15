import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = readFileSync(
  new URL("../migrations/0023_manufacturer_resolution.sql", import.meta.url),
  "utf8",
);

test("manufacturer resolution migration separates raw, canonical and provenance fields", () => {
  for (const column of [
    "normalized_raw_manufacturer",
    "canonical_manufacturer_id",
    "manufacturer_resolution_status",
    "manufacturer_resolution_method",
    "manufacturer_resolution_confidence",
    "raw_model",
    "normalized_model",
    "model_resolution_status",
    "model_resolution_method",
    "model_resolution_confidence",
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN ${column}\\b`));
  }
  assert.match(migration, /raw_model = model/);
  assert.match(migration, /manufacturerNormalization\.matchedAlias/);
});

test("manufacturer alias persistence keeps verification and audit metadata", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS knowledge_catalog_manufacturers/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS knowledge_catalog_manufacturer_aliases/);
  assert.match(migration, /normalized_alias TEXT NOT NULL/);
  assert.match(migration, /verification_status TEXT NOT NULL/);
  assert.match(migration, /source TEXT NOT NULL/);
  assert.match(migration, /provenance_json TEXT NOT NULL/);
  assert.match(migration, /rule_version INTEGER NOT NULL/);
  assert.match(migration, /idx_knowledge_catalog_manufacturer_alias_lookup/);
});

test("production-shaped legacy rows backfill without losing raw evidence", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      raw_manufacturer TEXT NOT NULL DEFAULT '',
      manufacturer_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO products(id, raw_manufacturer, manufacturer_id, model, metadata_json)
    VALUES
      (1, 'TAD', 'tad', 'D-1000 MKII', '{"manufacturerNormalization":{"matchedAlias":true}}'),
      (2, 'Unknown Audio', 'unknown-audio', 'X-1', '{"manufacturerNormalization":{"matchedAlias":false}}');
  `);

  db.exec(migration);

  const rows = db
    .prepare(
      `SELECT id, raw_manufacturer, normalized_raw_manufacturer, canonical_manufacturer_id,
              manufacturer_resolution_status, raw_model, model_resolution_status
       FROM products ORDER BY id`,
    )
    .all()
    .map((row) => ({ ...row })) as Array<Record<string, unknown>>;
  assert.deepEqual(rows, [
    {
      id: 1,
      raw_manufacturer: "TAD",
      normalized_raw_manufacturer: "tad",
      canonical_manufacturer_id: "tad",
      manufacturer_resolution_status: "resolved",
      raw_model: "D-1000 MKII",
      model_resolution_status: "resolved",
    },
    {
      id: 2,
      raw_manufacturer: "Unknown Audio",
      normalized_raw_manufacturer: "unknownaudio",
      canonical_manufacturer_id: "",
      manufacturer_resolution_status: "unresolved",
      raw_model: "X-1",
      model_resolution_status: "resolved",
    },
  ]);
  db.close();
});
