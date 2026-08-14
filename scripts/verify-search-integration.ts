/**
 * Proves the search stack against real SQLite, not against SQL-shape assertions.
 *
 * Unit tests can only show that a repository emits the SQL it was asked to emit. Two of the things
 * that matter most here — that the FTS5 trigram index actually resolves `TAD 1000`, and that two
 * shops' listings of one confirmed product collapse into a single search entity while an
 * unconfirmed listing stays separate — are properties of the database. This runs after
 * `db:migrate:local` in CI so a migration or a grouping predicate that only looks right cannot
 * reach production.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteEmptyEntitiesSql,
  deleteInactiveOffersSql,
  refreshEntityAggregatesSql,
  refreshEntitySearchTermsSql,
  upsertCatalogEntitiesSql,
  upsertCatalogOffersSql,
  upsertFallbackEntitiesSql,
  upsertFallbackOffersSql,
} from "../src/db/product-search-entity-sql.js";
import { isRecord } from "../src/types.js";

const suffix = `integration-${process.pid}`;
const matchedShopA = `${suffix}-a`;
const matchedShopB = `${suffix}-b`;
const unresolvedShop = `${suffix}-c`;
const now = "2026-08-12T00:00:00.000Z";

const statementFile = join(mkdtempSync(join(tmpdir(), "hifiscout-search-check-")), "statement.sql");

/**
 * Statements go through a file rather than `--command`: several of them are multi-line and contain
 * quotes, which no single argument-quoting rule survives on both Windows and Linux.
 */
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

function listing(shopKey: string, model: string, title: string, price: number): string {
  return `
    INSERT INTO products(
      shop_key, source_id, manufacturer, model, title, category, condition_text,
      price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at, is_active,
      raw_manufacturer, manufacturer_id, raw_category, primary_category_id, category_ids,
      classification_status, search_aliases, last_activity_at
    ) VALUES (
      '${shopKey}', '${suffix}', 'TAD', '${model}', '${title}', 'DAC', '中古',
      ${price}, 'in_stock', 'https://example.test/${shopKey}', '${now}', '${now}', '${now}', 1,
      'Technical Audio Devices', 'tad', 'D/Aコンバーター', 'dac', '["dac"]',
      'classified', 'DAC D/A Converter DAコンバーター', '${now}'
    );
  `;
}

function listingId(shopKey: string): number {
  const rows = d1(
    `SELECT id FROM products WHERE shop_key = '${shopKey}' AND source_id = '${suffix}';`,
  );
  return Number(rows[0]?.id);
}

function number(rows: Record<string, unknown>[], column: string): number {
  return Number(rows[0]?.[column] ?? -1);
}

try {
  d1(listing(matchedShopA, "D1000MK2", "TAD D1000MK2", 500000));
  d1(listing(matchedShopB, "D1000MK2", "Technical Audio Devices D1000MK2", 520000));
  d1(listing(unresolvedShop, "D1000TX", "TAD D1000TX", 540000));

  // --- Phase 1: the listing search projection still resolves multi-term FTS queries.
  const ftsRows = d1(`
    SELECT p.shop_key
    FROM products p
    JOIN product_search_projection sp ON sp.product_id = p.id
    JOIN product_search_fts ON product_search_fts.rowid = sp.product_id
    WHERE product_search_fts MATCH '"TAD" AND "1000"'
      AND p.shop_key = '${matchedShopA}';
  `);
  assert.equal(
    ftsRows.length,
    1,
    "TAD 1000 must resolve through product_search_fts after migrations",
  );

  // --- Phase 4: two shops' confirmed listings must become one product, and an unconfirmed
  // listing must remain its own searchable product.
  d1(`
    INSERT INTO knowledge_catalog_products(
      manufacturer_id, canonical_model, normalized_model, canonical_name,
      verification_status, created_at, updated_at
    ) VALUES ('tad', 'D1000MK2', 'D1000MK2', 'TAD D1000MK2', 'verified', '${now}', '${now}');
  `);
  const catalogId = number(
    d1(
      `SELECT id FROM knowledge_catalog_products WHERE manufacturer_id = 'tad' AND normalized_model = 'D1000MK2';`,
    ),
    "id",
  );
  const [idA, idB, idC] = [matchedShopA, matchedShopB, unresolvedShop].map(listingId);

  for (const [id, catalog, status, method] of [
    [idA, String(catalogId), "matched", "manufacturer_model_exact"],
    [idB, String(catalogId), "matched", "catalog_alias"],
    // Deliberately a candidate, not a match: a fuzzy suggestion must never merge listings.
    [idC, "NULL", "unresolved", "fuzzy_candidate"],
  ] as const) {
    d1(`
      INSERT OR REPLACE INTO product_identity_resolutions(
        listing_product_id, catalog_product_id, candidate_catalog_product_id, status, match_method,
        confidence, normalized_model, model_stem, variants_json, matched_fields_json,
        rejected_by_json, evaluated_at
      ) VALUES (
        ${id}, ${catalog}, ${status === "matched" ? "NULL" : catalogId}, '${status}', '${method}',
        '${status === "matched" ? "high" : "low"}', 'D1000MK2', 'D1000', '[]', '[]', '[]', '${now}'
      );
    `);
  }

  for (const sql of [
    upsertCatalogEntitiesSql(),
    upsertFallbackEntitiesSql(),
    deleteInactiveOffersSql(),
    upsertCatalogOffersSql(),
    upsertFallbackOffersSql(),
    refreshEntityAggregatesSql(),
    refreshEntitySearchTermsSql(),
    deleteEmptyEntitiesSql(),
  ]) {
    d1(`${sql};`);
  }

  const grouped = d1(`
    SELECT e.offer_count, e.shop_count, e.lowest_price_yen,
           (SELECT COUNT(*) FROM product_search_entity_offers m WHERE m.entity_id = e.id) AS members
    FROM product_search_entities e
    WHERE e.entity_key = 'c-${catalogId}';
  `);
  assert.equal(number(grouped, "members"), 2, "both confirmed listings must join one product");
  assert.equal(number(grouped, "shop_count"), 2, "the product must report both shops");
  assert.equal(
    number(grouped, "lowest_price_yen"),
    500000,
    "the product price is the lowest offer",
  );

  const fallback = d1(`
    SELECT e.entity_kind,
           (SELECT COUNT(*) FROM product_search_entity_offers m WHERE m.entity_id = e.id) AS members
    FROM product_search_entities e
    WHERE e.entity_key = 'l-${idC}';
  `);
  assert.equal(fallback[0]?.entity_kind, "unresolved_listing", "a candidate must not be merged");
  assert.equal(number(fallback, "members"), 1, "an unresolved listing stays searchable on its own");

  const membership = d1(`
    SELECT COUNT(*) AS wrong
    FROM product_search_entity_offers m
    JOIN product_search_entities e ON e.id = m.entity_id
    WHERE m.listing_product_id = ${idC} AND e.entity_key = 'c-${catalogId}';
  `);
  assert.equal(
    number(membership, "wrong"),
    0,
    "a fuzzy candidate must never reach the catalog product",
  );

  const entityFts = d1(`
    SELECT e.entity_key
    FROM product_search_entities e
    JOIN product_search_entities_fts ON product_search_entities_fts.rowid = e.id
    WHERE product_search_entities_fts MATCH '"TAD" AND "1000"'
      AND e.entity_key = 'c-${catalogId}';
  `);
  assert.equal(entityFts.length, 1, "the product entity must be reachable through its FTS index");

  console.log("search migration and product grouping integration checks passed");
} finally {
  d1(
    `DELETE FROM products WHERE source_id = '${suffix}' AND shop_key IN ('${matchedShopA}', '${matchedShopB}', '${unresolvedShop}');`,
  );
  d1(
    `DELETE FROM knowledge_catalog_products WHERE manufacturer_id = 'tad' AND normalized_model = 'D1000MK2';`,
  );
  d1(`${deleteEmptyEntitiesSql()};`);
}
