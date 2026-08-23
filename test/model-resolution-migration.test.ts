import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { MODEL_RESOLVER_VERSION } from "../src/catalog/model-resolver.js";

const migration = readFileSync(
  new URL("../migrations/0024_model_resolution_remediation.sql", import.meta.url),
  "utf8",
);

test("model resolution gains a rule version behind the current resolver", () => {
  assert.match(migration, /ADD COLUMN model_resolver_version INTEGER NOT NULL DEFAULT 1\b/);
  // Existing rows must stay selectable for replay rather than claiming to be current.
  assert.ok(MODEL_RESOLVER_VERSION > 1);
  assert.match(migration, /idx_products_model_resolver_version/);
  assert.match(migration, /ADD COLUMN remediation_projection_required INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /ADD COLUMN remediation_projection_token TEXT NOT NULL DEFAULT ''/);
  assert.match(migration, /idx_products_remediation_projection_required/);
  assert.match(migration, /idx_products_identity_group/);
});

test("candidate rows carry the evidence a reviewer needs", () => {
  for (const column of [
    "other_count",
    "unresolved_identity_count",
    "raw_model_variants",
    "evidence_source_urls",
    "identity_rejection_reason",
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN ${column}\\b`));
  }
  assert.match(migration, /idx_knowledge_catalog_candidates_remediation/);
});

test("catalog remediation progress is a durable watermark, not a time window", () => {
  assert.match(migration, /ADD COLUMN last_remediated_at TEXT/);
  assert.match(migration, /ADD COLUMN remediation_after_listing_id INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /idx_knowledge_catalog_products_remediation/);
});

test("remediation provenance records before and after values", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS data_quality_remediation_events/);
  assert.match(migration, /previous_value TEXT NOT NULL/);
  assert.match(migration, /new_value TEXT NOT NULL/);
  assert.match(migration, /resolver_version INTEGER NOT NULL/);
  assert.match(migration, /CHECK \(field IN \('manufacturer', 'model', 'category', 'identity'\)\)/);
});

test("production-shaped rows migrate without losing raw evidence", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      canonical_manufacturer_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      raw_model TEXT NOT NULL DEFAULT '',
      normalized_model TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO products(id, canonical_manufacturer_id, model, raw_model, normalized_model)
    VALUES (1, 'tad', 'D-1000 MKII', 'D-1000 MKII', 'd1000mkii');

    CREATE TABLE knowledge_catalog_products (
      id INTEGER PRIMARY KEY,
      manufacturer_id TEXT NOT NULL,
      canonical_model TEXT NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'verified',
      last_verified_at TEXT,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO knowledge_catalog_products(id, manufacturer_id, canonical_model, last_verified_at)
    VALUES (1, 'tad', 'D-1000 MKII', '2026-08-14T00:00:00.000Z');

    CREATE TABLE knowledge_catalog_candidates (
      id INTEGER PRIMARY KEY,
      manufacturer_id TEXT NOT NULL,
      normalized_model TEXT NOT NULL,
      observed_model TEXT NOT NULL DEFAULT '',
      priority_score INTEGER NOT NULL DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'pending'
    );
    INSERT INTO knowledge_catalog_candidates(id, manufacturer_id, normalized_model, observed_model)
    VALUES (1, 'tad', 'D-1000 MKII', 'D-1000 MKII'), (2, 'tad', 'D-2000', '');
  `);

  db.exec(migration);

  const product = db
    .prepare(
      `SELECT raw_model, normalized_model, model_resolver_version,
              remediation_projection_required, remediation_projection_token
       FROM products WHERE id = 1`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...product },
    {
      raw_model: "D-1000 MKII",
      normalized_model: "d1000mkii",
      model_resolver_version: 1,
      remediation_projection_required: 0,
      remediation_projection_token: "",
    },
  );

  const catalogProgress = db
    .prepare(
      "SELECT last_remediated_at, remediation_after_listing_id FROM knowledge_catalog_products WHERE id = 1",
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...catalogProgress },
    { last_remediated_at: null, remediation_after_listing_id: 0 },
  );

  // Every already-verified entry starts owed a replay, so the existing catalog is remediated once
  // rather than being treated as already done.
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS pending FROM knowledge_catalog_products
       WHERE verification_status = 'verified'
         AND (last_remediated_at IS NULL OR last_remediated_at < last_verified_at)`,
    )
    .get() as Record<string, unknown>;
  assert.equal(pending.pending, 1);

  const candidates = db
    .prepare(
      `SELECT id, raw_model_variants, evidence_source_urls, unresolved_identity_count,
              identity_rejection_reason
       FROM knowledge_catalog_candidates ORDER BY id`,
    )
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(candidates, [
    {
      id: 1,
      raw_model_variants: '["D-1000 MKII"]',
      evidence_source_urls: "[]",
      unresolved_identity_count: 0,
      identity_rejection_reason: "",
    },
    {
      id: 2,
      raw_model_variants: "[]",
      evidence_source_urls: "[]",
      unresolved_identity_count: 0,
      identity_rejection_reason: "",
    },
  ]);
  db.close();
});
