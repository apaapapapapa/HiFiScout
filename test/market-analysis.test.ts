import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { calculateMarketAnalysis } from "../src/catalog/market-analysis.js";
import type { MarketOffer, MarketSample } from "../src/catalog/market-analysis.js";
import {
  maintainMarketAnalysis,
  loadMarketAnalysis,
} from "../src/db/market-analysis-repository.js";
import { updateOfferFactAdmin } from "../src/db/offer-fact-admin-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { invocationBudget } from "../src/db/invocation-budget.js";
import { migrationSources } from "./helpers/migrations.js";

const AT = "2026-09-07T00:00:00.000Z";
const NOW = new Date(AT);
const quote = (id: number, price = id * 100): MarketOffer => ({
  id,
  shop_key: id === 1 ? "a" : "b",
  price_yen: price,
  stock_status: "in_stock",
  is_active: 1,
  last_seen_at: AT,
});
const sample = (id: number, listing = id, price = id * 100, at = AT): MarketSample => ({
  id,
  listing_product_id: listing,
  shop_key: listing === 1 ? "a" : "b",
  price_yen: price,
  sample_kind: "asking",
  signal_kind: "asking",
  observed_at: at,
});

test("condition bands separate selling units, conflicts, stale offers and sparse evidence", () => {
  const facts = new Map([
    [1, ["used", "sale_pair"]],
    [2, ["used", "sale_pair"]],
    [3, ["used", "sale_pair"]],
    [4, ["used", "sale_single"]],
    [5, ["used", "junk", "operation_unchecked"]],
  ]);
  const result = calculateMarketAnalysis(
    [
      quote(1),
      quote(2),
      quote(3),
      quote(4),
      quote(5),
      { ...quote(6), last_seen_at: "2026-01-01T00:00:00Z" },
      { ...quote(7), stock_status: "sold_out" },
    ],
    facts,
    [],
    NOW,
  );
  const pair = result.current_conditions.find((band) => band.sale_unit === "pair")!;
  assert.equal(pair.listing_count, 3);
  assert.equal(pair.shop_count, 2);
  assert.equal(pair.median_yen, 200);
  assert.equal(
    result.current_conditions.find((band) => band.sale_unit === "single")?.median_yen,
    null,
  );
  assert.ok(result.current_conditions.some((band) => band.condition === "mixed"));
  assert.equal(
    result.current_conditions.reduce((sum, band) => sum + band.listing_count, 0),
    5,
  );
});

test("monthly quotes give each listing one vote and first/end observations remain distinct", () => {
  const samples = [
    sample(1),
    sample(2),
    sample(3),
    sample(4, 1, 110),
    sample(5, 1, 120),
    sample(6, 1, 80, "2026-08-01T00:00:00Z"),
    { ...sample(7, 2), sample_kind: "listing_end", signal_kind: "sold_out" },
    { ...sample(8, 2), sample_kind: "listing_end", signal_kind: "sold_out" },
    { ...sample(9, 2), sample_kind: "listing_end", signal_kind: "deactivated" },
  ];
  const result = calculateMarketAnalysis([], new Map(), samples, NOW);
  const september = result.months.at(-1)!;
  assert.equal(september.listing_count, 3);
  assert.equal(september.median_yen, 200);
  assert.equal(september.min_yen, 120);
  assert.equal(september.first_observed_listings, 2);
  assert.equal(september.sold_out_listings, 1);
  assert.equal(september.deactivated_listings, 1);
  assert.equal(result.months.at(-2)?.median_yen, null);
});

function seed(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]) {
  sqlite.exec(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
    VALUES(700001,'fixture','Market model','MARKETMODEL','${AT}','${AT}');
    INSERT INTO product_search_entities(id,entity_key,entity_kind,catalog_product_id,model,offer_count,in_stock_offer_count)
      VALUES(700001,'c-700001','catalog',700001,'Market model',3,3);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<3)
    INSERT INTO products(id,shop_key,source_id,title,source_url,price_yen,stock_status,first_seen_at,last_seen_at,last_changed_at)
      SELECT i,CASE WHEN i=1 THEN 'a' ELSE 'b' END,'source'||i,'Market model','https://example.test/'||i,i*100,'in_stock','${AT}','${AT}','${AT}' FROM n;
    INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key) SELECT id,700001,shop_key FROM products;
    INSERT INTO product_offer_facts(product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at)
      SELECT id,'used','seller','present','condition_text','fixture',1,'${AT}' FROM products;`);
}

test("upgrade queues retained evidence and catalog removal cascades its derived state", async () => {
  const migration = "0109_condition_market_analysis.sql";
  const { db, sqlite } = migratedSqlite({ before: migration });
  try {
    seed(sqlite);
    const retained = sqlite.prepare("SELECT * FROM product_offer_facts").all();
    sqlite.exec(migrationSources.find((entry) => entry.name === migration)!.sql);
    assert.deepEqual(sqlite.prepare("SELECT * FROM product_offer_facts").all(), retained);
    for (const current of migrationSources.filter((entry) => entry.name > migration))
      sqlite.exec(current.sql);
    assert.equal((await maintainMarketAnalysis(db, NOW)).refreshed, 1);
    assert.equal((await loadMarketAnalysis(db, 700001))?.current_conditions[0]?.median_yen, 200);
    await updateOfferFactAdmin(db, 1, { used: "unknown" }, AT);
    sqlite.exec("DELETE FROM knowledge_catalog_products WHERE id=700001");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_market_dirty").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_market_analysis").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM products").get()?.n, 3);
  } finally {
    sqlite.close();
  }
});

test("projections coalesce changes, honor manual unknown, reject stale claims and recover failures", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    seed(sqlite);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_market_dirty").get()?.n, 1);
    assert.equal(await loadMarketAnalysis(db, 700001), null);
    assert.equal((await maintainMarketAnalysis(db, NOW)).refreshed, 1);
    assert.equal((await loadMarketAnalysis(db, 700001))?.current_conditions[0]?.median_yen, 200);
    const changes = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    const statements: string[] = [];
    const observed = {
      ...db,
      prepare: (sql: string) => {
        statements.push(sql);
        return db.prepare(sql);
      },
    };
    assert.equal((await maintainMarketAnalysis(observed, NOW)).selected, 0);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changes);
    assert.ok(
      !statements.some((sql) => sql.includes("FROM knowledge_catalog_price_index_samples")),
    );
    await updateOfferFactAdmin(db, 1, { used: "unknown" }, AT);
    const racing = {
      ...db,
      batch: async <T>(batch: D1PreparedStatement[]) => {
        await updateOfferFactAdmin(db, 2, { used: "unknown" }, AT);
        return db.batch<T>(batch);
      },
    };
    assert.equal((await maintainMarketAnalysis(racing, NOW)).refreshed, 0);
    assert.equal(await loadMarketAnalysis(db, 700001), null);
    await maintainMarketAnalysis(db, NOW);
    assert.equal(
      (await loadMarketAnalysis(db, 700001))?.current_conditions.find(
        (band) => band.condition === "unknown",
      )?.listing_count,
      2,
    );
    sqlite.exec(
      `INSERT INTO catalog_market_dirty(catalog_product_id,claim_token,claimed_at) VALUES(700001,'abandoned','2026-09-06T00:00:00Z')`,
    );
    assert.equal((await maintainMarketAnalysis(db, NOW)).refreshed, 1);
    sqlite.exec(
      "UPDATE knowledge_catalog_products SET verification_status='rejected' WHERE id=700001",
    );
    assert.equal(await loadMarketAnalysis(db, 700001), null);
  } finally {
    sqlite.close();
  }
});

test("the invocation budget yields before a claim and failed publication leaves durable recovery", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    seed(sqlite);
    await assert.rejects(
      maintainMarketAnalysis(invocationBudget(db, { maxCalls: 3 }).db, NOW),
      /budget exhausted/,
    );
    assert.equal(
      sqlite.prepare("SELECT claim_token FROM catalog_market_dirty").get()?.claim_token,
      null,
    );
    sqlite.exec(
      "CREATE TRIGGER fail_market BEFORE INSERT ON catalog_market_analysis BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    await assert.rejects(maintainMarketAnalysis(db, NOW), /injected/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_market_dirty").get()?.n, 1);
    assert.equal(await loadMarketAnalysis(db, 700001), null);
    sqlite.exec("DROP TRIGGER fail_market");
    await maintainMarketAnalysis(db, new Date("2026-09-07T02:00:00Z"));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_market_dirty").get()?.n, 0);
  } finally {
    sqlite.close();
  }
});
