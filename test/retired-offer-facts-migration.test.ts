import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  maintainMarketAnalysis,
  loadMarketAnalysis,
} from "../src/db/market-analysis-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";

const MIGRATION = "0144_retire_sale_unit_voltage_option_offer_facts.sql";
const AT = "2026-09-07T00:00:00.000Z";
const RETIRED = [
  "sale_pair",
  "sale_single",
  "sale_set",
  "voltage_100v",
  "voltage_115v",
  "voltage_120v",
  "voltage_220v",
  "voltage_230v",
  "voltage_240v",
  "voltage_switchable",
  "option_dac",
  "option_phono",
  "option_network",
];
const band = (condition: string, saleUnit: string, listings: number) => ({
  listing_count: listings,
  shop_count: 1,
  median_yen: null,
  min_yen: null,
  max_yen: null,
  first_observed_at: AT,
  last_observed_at: AT,
  condition,
  sale_unit: saleUnit,
});
const analysis = (...bands: ReturnType<typeof band>[]) =>
  JSON.stringify({ version: 1, status: "ready", as_of: AT, current_conditions: bands, months: [] });

function seed(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]) {
  sqlite.exec(`
    INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
      VALUES (700001,'fixture','Split','SPLIT','${AT}','${AT}'),(700002,'fixture','Single','SINGLE','${AT}','${AT}');
    INSERT INTO product_search_entities(id,entity_key,entity_kind,catalog_product_id,model,offer_count,in_stock_offer_count)
      VALUES (700001,'c-700001','catalog',700001,'Split',4,4);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4)
    INSERT INTO products(id,shop_key,source_id,title,source_url,price_yen,stock_status,first_seen_at,last_seen_at,last_changed_at)
      SELECT i,CASE WHEN i=1 THEN 'a' ELSE 'b' END,'source'||i,'Split','https://example.test/'||i,i*100,'in_stock','${AT}','${AT}','${AT}' FROM n;
    INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key) SELECT id,700001,shop_key FROM products;
    INSERT INTO product_offer_facts(product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at)
      SELECT id,'used','seller','present','condition_text','fixture',1,'${AT}' FROM products;`);
  const fact = sqlite.prepare(`INSERT INTO product_offer_facts
    (product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at) VALUES (?,?,?,?,?,?,1,?)`);
  RETIRED.forEach((id, index) => {
    const product = (index % 4) + 1;
    fact.run(product, id, "seller", "present", "title", `offer.v3.${id}`, AT);
    if (index % 3 === 0) fact.run(product, id, "manual", "unknown", "manual", "manual", AT);
    if (index % 5 === 0)
      fact.run(product, id, "seller_detail", "absent", "detail_accessories", id, AT);
  });
  const store = sqlite.prepare(
    "INSERT INTO catalog_market_analysis(catalog_product_id,analysis_json,next_refresh_at) VALUES (?,?,?)",
  );
  store.run(700001, analysis(band("used", "pair", 3), band("used", "single", 1)), "2026-09-08");
  store.run(700002, analysis(band("junk", "unknown", 1), band("used", "pair", 2)), "2026-09-08");
  sqlite.exec(`INSERT INTO product_offer_fact_replays(rule_version,max_product_id,coverage_json,started_at,updated_at)
    VALUES (3,4,'{"byShop":[{"key":"a","listings":2,"condition":1,"sale_unit":1,"voltage":0,"option":1}],"byCategory":[{"key":"amp","listings":2,"included":2,"sale_unit":2}]}','${AT}','${AT}')`);
  // Seeding is not part of the upgrade; start from an empty refresh queue.
  sqlite.exec("DELETE FROM catalog_market_dirty");
}

test("migration 0144 deletes only retired facts and rebuilds only sale-unit split projections", async () => {
  const { db, sqlite } = migratedSqlite({ before: MIGRATION });
  try {
    seed(sqlite);
    const retained = sqlite
      .prepare(
        `SELECT * FROM product_offer_facts WHERE fact_id NOT IN (SELECT value FROM json_each(?))
        ORDER BY product_id,fact_id,source`,
      )
      .all(JSON.stringify(RETIRED));
    sqlite.exec(migrationSources.find((entry) => entry.name === MIGRATION)!.sql);

    assert.deepEqual(
      sqlite.prepare("SELECT * FROM product_offer_facts ORDER BY product_id,fact_id,source").all(),
      retained,
    );
    // Deleting retired rows queues nothing by itself; only the merged projection needs listings.
    assert.deepEqual(
      sqlite
        .prepare("SELECT catalog_product_id AS id FROM catalog_market_dirty")
        .all()
        .map((row) => row.id),
      [700001],
    );
    const stored = Object.fromEntries(
      sqlite
        .prepare("SELECT catalog_product_id AS id, analysis_json FROM catalog_market_analysis")
        .all()
        .map((row) => [row.id, JSON.parse(String(row.analysis_json))]),
    );
    const { sale_unit: _junk, ...junk } = band("junk", "unknown", 1);
    const { sale_unit: _used, ...used } = band("used", "pair", 2);
    assert.deepEqual(stored[700002].current_conditions, [junk, used]);
    assert.deepEqual(
      stored[700001].current_conditions.map((row: Record<string, unknown>) => Object.keys(row)),
      [Object.keys(used), Object.keys(used)],
    );
    assert.deepEqual(
      JSON.parse(
        String(
          sqlite.prepare("SELECT coverage_json FROM product_offer_fact_replays").get()!
            .coverage_json,
        ),
      ),
      {
        byShop: [{ key: "a", listings: 2, condition: 1 }],
        byCategory: [{ key: "amp", listings: 2, included: 2 }],
      },
    );

    // Retired facts no longer invalidate market projections; condition facts still do.
    sqlite.exec("DELETE FROM catalog_market_dirty");
    sqlite.exec(`INSERT INTO product_offer_facts(product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at)
      VALUES (1,'sale_pair','seller','present','title','legacy',1,'${AT}')`);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_market_dirty").get()!.n, 0);
    sqlite.exec("DELETE FROM product_offer_facts WHERE fact_id='sale_pair'");
    sqlite.exec(
      `UPDATE product_offer_facts SET state='absent' WHERE product_id=1 AND fact_id='used'`,
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_market_dirty").get()!.n, 1);

    const now = new Date(AT);
    assert.equal((await maintainMarketAnalysis(db, now)).refreshed, 1);
    assert.deepEqual(
      (await loadMarketAnalysis(db, 700001))?.current_conditions.map((row) => [
        row.condition,
        row.listing_count,
        Object.hasOwn(row, "sale_unit"),
      ]),
      [
        ["unknown", 1, false],
        ["used", 3, false],
      ],
    );
  } finally {
    sqlite.close();
  }
});
