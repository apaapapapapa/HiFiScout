/**
 * Proves the durable listing-admin override contract against the real local D1 database.
 *
 * The admin write path stores corrected canonical fields while raw seller evidence remains owned by
 * the crawler. This check simulates a later crawl trying to restore its derived manufacturer/model/
 * category and proves the database keeps the explicit admin correction and category closure.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/types.js";

const suffix = `listing-admin-integration-${process.pid}`;
const now = "2026-08-22T00:00:00.000Z";
const statementFile = join(mkdtempSync(join(tmpdir(), "hifiscout-listing-admin-check-")), "statement.sql");

function d1(command: string): Record<string, unknown>[] {
  writeFileSync(statementFile, command, "utf8");
  const output = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "d1", "execute", "DB", "--local", "--json", `--file=${statementFile}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" },
  );
  const parsed: unknown = JSON.parse(output.slice(output.indexOf("[")));
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  return isRecord(first) && Array.isArray(first.results)
    ? (first.results as Record<string, unknown>[])
    : [];
}

function number(rows: Record<string, unknown>[], column: string): number {
  return Number(rows[0]?.[column] ?? -1);
}

try {
  d1(`
    INSERT INTO products(
      shop_key, source_id, manufacturer, model, title, category, condition_text,
      price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at, is_active,
      raw_manufacturer, normalized_raw_manufacturer, manufacturer_id, canonical_manufacturer_id,
      manufacturer_resolution_status, manufacturer_resolution_method,
      manufacturer_resolution_confidence, raw_model, normalized_model, model_resolution_status,
      model_resolution_method, model_resolution_confidence, raw_category, primary_category_id,
      category_ids, classification_status, search_aliases, last_activity_at
    ) VALUES (
      '${suffix}', '${suffix}', 'TAD', 'D1000MK2', 'TAD D1000MK2', 'DAC', '中古',
      500000, 'in_stock', 'https://example.test/${suffix}', '${now}', '${now}', '${now}', 1,
      'TAD', 'TAD', 'tad', 'tad', 'resolved', 'verified_alias', 'high',
      'D1000MK2', 'D1000MK2', 'resolved', 'seller_model', 'high',
      'D/Aコンバーター', 'dac', '["dac"]', 'classified', 'DAC', '${now}'
    );
  `);
  const listingId = number(
    d1(`SELECT id FROM products WHERE shop_key = '${suffix}' AND source_id = '${suffix}';`),
    "id",
  );
  assert.ok(listingId > 0, "fixture listing must exist");

  // This is the state the admin repository writes before persisting the durable override row.
  d1(`
    UPDATE products
    SET manufacturer = 'LUXMAN', manufacturer_id = 'luxman', canonical_manufacturer_id = 'luxman',
        manufacturer_resolution_status = 'resolved', manufacturer_resolution_method = 'verified_alias',
        manufacturer_resolution_confidence = 'high', model = 'D-1000', normalized_model = 'D1000',
        model_resolution_status = 'resolved', model_resolution_method = 'seller_model_annotated',
        model_resolution_confidence = 'high', category = 'アナログプレーヤー',
        primary_category_id = 'turntable', category_ids = '["turntable"]',
        classification_status = 'classified', search_aliases = 'turntable'
    WHERE id = ${listingId};
    DELETE FROM product_categories WHERE product_id = ${listingId};
    INSERT INTO product_categories(product_id, category_id) VALUES (${listingId}, 'turntable');
    INSERT INTO product_categories(product_id, category_id) VALUES (${listingId}, 'analog');
    INSERT INTO product_admin_overrides(
      listing_product_id, manufacturer_id, manufacturer_name, model, normalized_model,
      primary_category_id, category_ids, category_name, search_aliases, created_at, updated_at
    ) VALUES (
      ${listingId}, 'luxman', 'LUXMAN', 'D-1000', 'D1000',
      'turntable', '["turntable","analog"]', 'アナログプレーヤー', 'turntable', '${now}', '${now}'
    );
  `);

  // Simulate the next crawler upsert and its category synchronization. Raw evidence is allowed to
  // move, but the effective canonical fields and manual category membership must remain corrected.
  d1(`
    UPDATE products
    SET raw_manufacturer = 'Technical Audio Devices', normalized_raw_manufacturer = 'TECHNICAL AUDIO DEVICES',
        manufacturer = 'TAD', manufacturer_id = 'tad', canonical_manufacturer_id = 'tad',
        manufacturer_resolution_status = 'resolved', manufacturer_resolution_method = 'verified_alias',
        manufacturer_resolution_confidence = 'high', raw_model = 'D1000MK2', model = 'D1000MK2',
        normalized_model = 'D1000MK2', model_resolution_status = 'resolved',
        model_resolution_method = 'seller_model', model_resolution_confidence = 'high',
        raw_category = 'D/Aコンバーター', category = 'DAC', primary_category_id = 'dac',
        category_ids = '["dac"]', classification_status = 'classified', search_aliases = 'DAC'
    WHERE id = ${listingId};
    DELETE FROM product_categories WHERE product_id = ${listingId};
    INSERT OR IGNORE INTO product_categories(product_id, category_id) VALUES (${listingId}, 'dac');
    INSERT OR IGNORE INTO product_categories(product_id, category_id) VALUES (${listingId}, 'digital');
  `);

  const effective = d1(`
    SELECT manufacturer, canonical_manufacturer_id, model, normalized_model,
           category, primary_category_id, classification_status,
           raw_manufacturer, raw_model, raw_category
    FROM products WHERE id = ${listingId};
  `)[0];
  assert.equal(effective?.manufacturer, "LUXMAN");
  assert.equal(effective?.canonical_manufacturer_id, "luxman");
  assert.equal(effective?.model, "D-1000");
  assert.equal(effective?.normalized_model, "D1000");
  assert.equal(effective?.category, "アナログプレーヤー");
  assert.equal(effective?.primary_category_id, "turntable");
  assert.equal(effective?.classification_status, "classified");

  // Seller evidence remains crawler-owned instead of being hidden by the override.
  assert.equal(effective?.raw_manufacturer, "Technical Audio Devices");
  assert.equal(effective?.raw_model, "D1000MK2");
  assert.equal(effective?.raw_category, "D/Aコンバーター");

  const categories = d1(`
    SELECT category_id FROM product_categories WHERE product_id = ${listingId} ORDER BY category_id;
  `).map((row) => String(row.category_id));
  assert.deepEqual(categories, ["analog", "turntable"]);

  console.log("listing admin override persistence integration check passed");
} finally {
  d1(`DELETE FROM products WHERE shop_key = '${suffix}' AND source_id = '${suffix}';`);
}
