import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import { syncProductSearchEntities } from "../src/db/product-search-entity-repository.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";

const TARGET_LISTINGS = 29;
const MATCHED_TARGETS = 10;

test("scoped search sync stays bounded as unrelated catalog matches grow", async () => {
  const { db, dispose } = await database();
  const fixture = ["test/product-search-catalog-offer-budget.test.ts"];
  const insertListings = (from: number, to: number, shopKey: string, modelPrefix: string) =>
    db
      .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
        INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,
          last_changed_at,last_activity_at,stock_status,is_active,model_resolution_status,
          canonical_manufacturer_id,normalized_model,primary_category_id)
        SELECT i,?,'s'||i,?||i,'https://example.test/'||i,?,?,?,?,'in_stock',1,'resolved',
          'luxman',?||i,'AMP.INTEGRATED' FROM n`)
      .bind(from, to, shopKey, modelPrefix, AT, AT, AT, AT, modelPrefix)
      .run();
  const insertCatalogMatches = (from: number, to: number, modelPrefix: string) =>
    db.batch([
      db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
          INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,
            canonical_name,verification_status,created_at,updated_at)
          SELECT i,'luxman',?||i,?||i,'LUXMAN '||?||i,'verified',?,? FROM n`)
        .bind(from, to, modelPrefix, modelPrefix, modelPrefix, AT, AT),
      db
        .prepare(`INSERT INTO product_identity_resolutions(listing_product_id,catalog_product_id,status,
            match_method,confidence,evaluated_at)
          SELECT id,id,'matched','catalog_alias','high',? FROM products WHERE id BETWEEN ? AND ?`)
        .bind(AT, from, to),
    ]);
  try {
    // A small shop whose crawl reports the same listings again: some confirmed, most unresolved.
    await insertListings(1, TARGET_LISTINGS, "target", "T");
    await insertCatalogMatches(1, MATCHED_TARGETS, "T");
    await db
      .prepare(`INSERT INTO product_identity_resolutions(listing_product_id,status,match_method,
          confidence,evaluated_at)
        SELECT id,'unresolved','unresolved','none',? FROM products WHERE id > ?`)
      .bind(AT, MATCHED_TARGETS)
      .run();
    const sources = Array.from({ length: TARGET_LISTINGS }, (_, i) => `s${i + 1}`);
    await syncProductSearchEntities(db, "target", sources);

    let previous = 0;
    const reads: number[] = [];
    for (const size of [100, 1000, 10000]) {
      // Every other shop's confirmed listing, already converged into its catalog entity.
      const from = 1000 + previous + 1;
      const to = 1000 + size;
      await insertListings(from, to, "other", "U");
      await insertCatalogMatches(from, to, "U");
      await db.batch([
        db
          .prepare(`INSERT INTO product_search_entities(entity_key,entity_kind,catalog_product_id)
            SELECT 'c-'||id,'catalog',id FROM knowledge_catalog_products WHERE id BETWEEN ? AND ?`)
          .bind(from, to),
        db
          .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
            SELECT p.id,e.id,p.shop_key FROM products p JOIN product_search_entities e
              ON e.entity_key='c-'||p.id WHERE p.id BETWEEN ? AND ?`)
          .bind(from, to),
      ]);
      previous = size;

      // The crawl reports the target listings unchanged; membership must not move.
      const boundary = measureD1Cost(db);
      const result = await syncProductSearchEntities(boundary.db, "target", sources);
      const cost = boundary.metrics();
      await recordCostSample(`search-sync-catalog-offers-${size}`, "local-workerd", cost, fixture, [
        `Unchanged ${TARGET_LISTINGS}-listing sync with ${size} unrelated matched listings; real migrated D1.`,
      ]);
      assert.equal(result.listing_count, TARGET_LISTINGS);
      assert.equal(cost.rowsWritten, 0, JSON.stringify(cost));
      assert.ok(cost.rowsRead !== null && cost.rowsRead <= 4000, JSON.stringify(cost));
      reads.push(cost.rowsRead);
      console.log(JSON.stringify({ sample: `search-sync-catalog-offers-${size}`, ...cost }));
    }
    assert.equal(new Set(reads).size, 1, `reads must not grow with unrelated matches: ${reads}`);

    const offers = await db
      .prepare(`SELECT e.entity_kind, COUNT(*) AS offers FROM product_search_entity_offers m
        JOIN product_search_entities e ON e.id = m.entity_id
        WHERE m.listing_product_id <= ? GROUP BY e.entity_kind ORDER BY e.entity_kind`)
      .bind(TARGET_LISTINGS)
      .all();
    assert.deepEqual(offers.results, [
      { entity_kind: "catalog", offers: MATCHED_TARGETS },
      { entity_kind: "unresolved_listing", offers: TARGET_LISTINGS - MATCHED_TARGETS },
    ]);
  } finally {
    await dispose();
  }
}, 120_000);
