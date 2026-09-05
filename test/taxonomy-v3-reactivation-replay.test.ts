import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const V3_MIGRATION = "0068_category_taxonomy_v3.sql";
const REACTIVATION_MIGRATION = "0069_taxonomy_v3_reactivation_replay.sql";
const AT = "2026-08-30T00:00:00.000Z";

function databaseBeforeV3(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (file === V3_MIGRATION) break;
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  return sqlite;
}

function applyMigration(sqlite: DatabaseSync, file: string): void {
  sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
}

function insertInactiveLegacyListing(sqlite: DatabaseSync): void {
  const title = "Studio Desktop Class D Integrated Amplifier A1";
  sqlite
    .prepare(`
      INSERT INTO products (
        id, shop_key, source_id, manufacturer, raw_manufacturer, manufacturer_id,
        canonical_manufacturer_id, manufacturer_resolution_status, model, raw_model,
        normalized_model, model_resolution_status, title, category, raw_category,
        primary_category_id, category_ids, direct_category_ids, classification_status,
        search_aliases, condition_text, price_yen, stock_status, source_url, first_seen_at,
        last_seen_at, last_changed_at, last_activity_at, is_active, metadata_json
      ) VALUES (
        1201, 'legacy-shop', 'inactive-studio-amp', 'Example', 'Example', 'example',
        'example', 'resolved', 'A1', 'A1', 'A1', 'resolved', ?, 'integrated_amp',
        'integrated_amp', 'integrated_amp', json_array('integrated_amp'),
        '["integrated_amp"]', 'classified', 'integrated_amp', 'used', 100000,
        'in_stock', 'https://example.test/inactive-studio-amp', ?, ?, ?, ?, 0, '{}'
      )
    `)
    .run(title, AT, AT, AT, AT);
  sqlite
    .prepare(
      "INSERT INTO product_categories(product_id, category_id, is_direct) VALUES (1201, 'integrated_amp', 1)",
    )
    .run();
}

function targetFacets(sqlite: DatabaseSync): Record<string, unknown>[] {
  return sqlite
    .prepare(`
      SELECT facet_id, facet_value, source
      FROM product_facet_facts
      WHERE product_id = 1201
        AND facet_id IN ('form_factor', 'technology', 'use_case')
      ORDER BY facet_id, facet_value, source
    `)
    .all()
    .map((row) => ({ ...row }));
}

test("inactive taxonomy-v3 migration rows replay complete facets when reactivated unchanged", async () => {
  const sqlite = databaseBeforeV3();
  insertInactiveLegacyListing(sqlite);

  applyMigration(sqlite, V3_MIGRATION);
  applyMigration(sqlite, REACTIVATION_MIGRATION);

  const migrated = sqlite
    .prepare(`
      SELECT is_active,
             json_extract(metadata_json, '$.categoryClassification.version') AS version,
             json_extract(metadata_json, '$.categoryClassification.taxonomyVersion') AS taxonomy_version
      FROM products
      WHERE id = 1201
    `)
    .get() as { is_active: number; version: number; taxonomy_version: string };
  assert.equal(migrated.is_active, 0);
  assert.equal(migrated.version, 15);
  assert.equal(migrated.taxonomy_version, "v3");
  assert.deepEqual(targetFacets(sqlite), []);

  // Keep unrelated resolver stages current so this regression isolates the taxonomy-v3 replay.
  sqlite
    .prepare(
      "UPDATE products SET manufacturer_resolver_version = ?, model_resolver_version = ? WHERE id = 1201",
    )
    .run(RESOLUTION_VERSIONS.manufacturer, RESOLUTION_VERSIONS.model);

  // The seller evidence is intentionally unchanged: only the inactive -> active edge occurs.
  sqlite.prepare("UPDATE products SET is_active = 1 WHERE id = 1201").run();

  const queued = sqlite
    .prepare(`
      SELECT work_type, listing_product_id, reason, source, status, work_key
      FROM data_quality_remediation_queue
      WHERE listing_product_id = 1201
    `)
    .get() as {
    work_type: string;
    listing_product_id: number;
    reason: string;
    source: string;
    status: string;
    work_key: string;
  };
  assert.equal(queued.work_type, "classify_category");
  assert.equal(queued.listing_product_id, 1201);
  assert.equal(queued.reason, "taxonomy_v3_reactivation_facet_replay");
  assert.equal(queued.source, "taxonomy_v3_reactivation");
  assert.equal(queued.status, "pending");
  assert.match(queued.work_key, /^auto:classify_category:listing:1201:/);
  assert.match(queued.work_key, /:category:15:/);

  // Historical migrations above prove the reactivation edge. Runtime replay then uses the current
  // schema, including the durable projection obligations and indexed candidate retrieval.
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && name > REACTIVATION_MIGRATION)
    .sort()) {
    applyMigration(sqlite, file);
  }

  // Make the trigger-generated work immediately claimable without depending on the host clock.
  sqlite
    .prepare(
      "UPDATE data_quality_remediation_queue SET available_at = ?, updated_at = ? WHERE listing_product_id = 1201",
    )
    .run(AT, AT);

  const sweep = await runDataQualityRemediationSweep(sqliteD1(sqlite), {
    seedLimit: 10,
    claimLimit: 10,
    now: new Date("2026-08-30T01:00:00.000Z"),
  });
  assert.equal(sweep.claimed, 1);
  assert.equal(sweep.resolved, 1);
  assert.equal(sweep.failed, 0);

  assert.deepEqual(targetFacets(sqlite), [
    { facet_id: "form_factor", facet_value: "desktop", source: "title" },
    { facet_id: "technology", facet_value: "class_d", source: "title" },
    { facet_id: "use_case", facet_value: "studio", source: "title" },
  ]);

  const replayed = sqlite
    .prepare(
      "SELECT json_extract(metadata_json, '$.categoryClassification.version') AS version FROM products WHERE id = 1201",
    )
    .get() as { version: number };
  assert.equal(replayed.version, RESOLUTION_VERSIONS.category);
});
