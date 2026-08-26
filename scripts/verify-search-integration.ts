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
import { executeLocalD1, numberFrom, rowsFor } from "./lib/local-d1.js";

const suffix = `integration-${process.pid}`;
const matchedShopA = `${suffix}-a`;
const matchedShopB = `${suffix}-b`;
const unresolvedShop = `${suffix}-c`;
const now = "2026-08-12T00:00:00.000Z";

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

function listingId(shopKey: string): string {
  return `(SELECT id FROM products WHERE shop_key = '${shopKey}' AND source_id = '${suffix}')`;
}

const catalogId = `(SELECT id FROM knowledge_catalog_products WHERE manufacturer_id = 'tad' AND normalized_model = 'D1000MK2')`;
const idA = listingId(matchedShopA);
const idB = listingId(matchedShopB);
const idC = listingId(unresolvedShop);

const entityRefreshSql = [
  upsertCatalogEntitiesSql(),
  upsertFallbackEntitiesSql(),
  deleteInactiveOffersSql(),
  upsertCatalogOffersSql(),
  upsertFallbackOffersSql(),
  refreshEntityAggregatesSql(),
  refreshEntitySearchTermsSql(),
  deleteEmptyEntitiesSql(),
].join(";\n");

try {
  const rows = executeLocalD1(`
    ${listing(matchedShopA, "D1000MK2", "TAD D1000MK2", 500000)}
    ${listing(matchedShopB, "D1000MK2", "Technical Audio Devices D1000MK2", 520000)}
    ${listing(unresolvedShop, "D1000TX", "TAD D1000TX", 540000)}

    -- Phase 1: the listing search projection still resolves multi-term FTS queries.
    SELECT 'listing_fts' AS check_name, p.shop_key
    FROM products p
    JOIN product_search_projection sp ON sp.product_id = p.id
    JOIN product_search_fts ON product_search_fts.rowid = sp.product_id
    WHERE product_search_fts MATCH '"TAD" AND "1000"'
      AND p.shop_key = '${matchedShopA}';

    -- Phase 4: two shops' confirmed listings must become one product, and an unconfirmed listing
    -- must remain its own searchable product.
    INSERT INTO knowledge_catalog_products(
      manufacturer_id, canonical_model, normalized_model, canonical_name,
      verification_status, created_at, updated_at
    ) VALUES ('tad', 'D1000MK2', 'D1000MK2', 'TAD D1000MK2', 'verified', '${now}', '${now}');

    INSERT OR REPLACE INTO product_identity_resolutions(
      listing_product_id, catalog_product_id, candidate_catalog_product_id, status, match_method,
      confidence, normalized_model, model_stem, variants_json, matched_fields_json,
      rejected_by_json, evaluated_at
    ) VALUES
      (${idA}, ${catalogId}, NULL, 'matched', 'manufacturer_model_exact',
       'high', 'D1000MK2', 'D1000', '[]', '[]', '[]', '${now}'),
      (${idB}, ${catalogId}, NULL, 'matched', 'catalog_alias',
       'high', 'D1000MK2', 'D1000', '[]', '[]', '[]', '${now}'),
      (${idC}, NULL, ${catalogId}, 'unresolved', 'fuzzy_candidate',
       'low', 'D1000MK2', 'D1000', '[]', '[]', '[]', '${now}');

    ${entityRefreshSql};

    SELECT 'grouped' AS check_name,
           e.offer_count, e.shop_count, e.lowest_price_yen,
           (SELECT COUNT(*) FROM product_search_entity_offers m WHERE m.entity_id = e.id) AS members
    FROM product_search_entities e
    WHERE e.entity_key = 'c-' || ${catalogId};

    SELECT 'fallback' AS check_name,
           e.entity_kind,
           (SELECT COUNT(*) FROM product_search_entity_offers m WHERE m.entity_id = e.id) AS members
    FROM product_search_entities e
    WHERE e.entity_key = 'l-' || ${idC};

    SELECT 'membership' AS check_name, COUNT(*) AS wrong
    FROM product_search_entity_offers m
    JOIN product_search_entities e ON e.id = m.entity_id
    WHERE m.listing_product_id = ${idC} AND e.entity_key = 'c-' || ${catalogId};

    SELECT 'entity_fts' AS check_name, e.entity_key
    FROM product_search_entities e
    JOIN product_search_entities_fts ON product_search_entities_fts.rowid = e.id
    WHERE product_search_entities_fts MATCH '"TAD" AND "1000"'
      AND e.entity_key = 'c-' || ${catalogId};
  `);

  assert.equal(
    rowsFor(rows, "listing_fts").length,
    1,
    "TAD 1000 must resolve through product_search_fts after migrations",
  );

  const grouped = rowsFor(rows, "grouped");
  assert.equal(numberFrom(grouped, "members"), 2, "both confirmed listings must join one product");
  assert.equal(numberFrom(grouped, "shop_count"), 2, "the product must report both shops");
  assert.equal(
    numberFrom(grouped, "lowest_price_yen"),
    500000,
    "the product price is the lowest offer",
  );

  const fallback = rowsFor(rows, "fallback");
  assert.equal(fallback[0]?.entity_kind, "unresolved_listing", "a candidate must not be merged");
  assert.equal(
    numberFrom(fallback, "members"),
    1,
    "an unresolved listing stays searchable on its own",
  );

  assert.equal(
    numberFrom(rowsFor(rows, "membership"), "wrong"),
    0,
    "a fuzzy candidate must never reach the catalog product",
  );

  assert.equal(
    rowsFor(rows, "entity_fts").length,
    1,
    "the product entity must be reachable through its FTS index",
  );

  console.log("search migration and product grouping integration checks passed");
} finally {
  executeLocalD1(`
    DELETE FROM products
    WHERE source_id = '${suffix}'
      AND shop_key IN ('${matchedShopA}', '${matchedShopB}', '${unresolvedShop}');
    DELETE FROM knowledge_catalog_products
    WHERE manufacturer_id = 'tad' AND normalized_model = 'D1000MK2';
    ${deleteEmptyEntitiesSql()};
  `);
}
