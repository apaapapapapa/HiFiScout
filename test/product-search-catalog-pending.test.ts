import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { invocationBudget, InvocationBudgetExceeded } from "../src/db/invocation-budget.js";
import { repairActiveListingProjectionGaps } from "../src/db/product-search-gap-repair.js";
import { asQueryableDatabase } from "./helpers/d1.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";
import { queryPlan, recordingDatabase } from "./helpers/query-plan.js";

const MIGRATION = "0096_product_search_catalog_pending.sql";
const AT = "2030-01-01T12:00:00.000Z";

function fixture(beforeMigration = false) {
  const result = migratedSqlite(beforeMigration ? { before: MIGRATION } : {});
  result.sqlite.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<51)
    INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,
      canonical_manufacturer_id,model,normalized_model,model_resolution_status)
    SELECT i,'pending',CAST(i AS TEXT),'Model '||i,'https://example.test/'||i,'${AT}','${AT}','${AT}',
      'luxman','M-'||i,'M'||i,'resolved' FROM n;
    INSERT INTO product_identity_resolutions(listing_product_id,status,match_method,confidence,evaluated_at)
    SELECT id,'unresolved','unresolved','none','${AT}' FROM products;
    INSERT INTO product_search_entities(entity_key,entity_kind,fallback_listing_id)
    SELECT 'listing:'||id,'unresolved_listing',id FROM products;
    INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
    SELECT p.id,e.id,p.shop_key FROM products p JOIN product_search_entities e ON e.fallback_listing_id=p.id;
    DELETE FROM listing_projection_pending;
    INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,
      verification_status,created_at,updated_at)
    VALUES (900001,'luxman','M-51','M51','LUXMAN M-51','verified','${AT}','${AT}');
  `);
  return result;
}

function match(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]) {
  sqlite.exec(`UPDATE product_identity_resolutions SET status='matched',catalog_product_id=900001,
    match_method='test_catalog_match',confidence='high' WHERE listing_product_id=51;`);
}

test("migration queues legacy drift beyond the audit window and repairs it within one cron budget", async () => {
  const { db, sqlite } = fixture(true);
  match(sqlite);
  sqlite.exec(migrationSources.find((migration) => migration.name === MIGRATION)!.sql);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_search_catalog_pending").get()?.n, 1);
  // A different full projection obligation must survive this membership-only repair.
  sqlite.exec(
    "INSERT INTO listing_projection_pending(listing_product_id,token) VALUES (51,'full-edit')",
  );
  const recorded = recordingDatabase(db);
  const budget = invocationBudget(recorded.db, { finalizationReserve: 5 });
  for (let i = 0; i < 8; i++) await budget.db.prepare("SELECT 1").first();
  const result = await repairActiveListingProjectionGaps(budget.db, {
    evaluatedAt: AT,
    phases: "coverage",
    maxListings: 1,
    maxScannedListings: 25,
  });
  assert.equal(result.repairedCount, 1);
  assert.equal(result.selectedCount, 1);
  assert.equal(result.scannedCount, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_search_catalog_pending").get()?.n, 0);
  assert.equal(
    sqlite.prepare("SELECT token FROM listing_projection_pending WHERE listing_product_id=51").get()
      ?.token,
    "full-edit",
  );
  assert.equal(
    sqlite
      .prepare(`SELECT e.entity_kind FROM product_search_entities e
    JOIN product_search_entity_offers o ON o.entity_id=e.id WHERE o.listing_product_id=51`)
      .get()?.entity_kind,
    "catalog",
  );
  assert.equal(
    sqlite
      .prepare("SELECT match_method FROM product_identity_resolutions WHERE listing_product_id=51")
      .get()?.match_method,
    "test_catalog_match",
  );
  assert.ok(budget.metrics().d1Calls <= 40, JSON.stringify(budget.metrics()));
  const selector = recorded.executed.find((statement) =>
    statement.sql.includes("FROM product_search_catalog_pending pending"),
  )!;
  const plan = queryPlan(sqlite, selector)
    .map((step) => step.detail)
    .join("\n");
  assert.match(plan, /idx_product_search_catalog_pending_attempt/);
  assert.doesNotMatch(plan, /SCAN p\b|TEMP B-TREE/);
});

test("only real eligible identity or catalog transitions create membership obligations", () => {
  const { sqlite } = fixture();
  sqlite.exec(
    "UPDATE knowledge_catalog_products SET verification_status='rejected' WHERE id=900001",
  );
  match(sqlite);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_search_catalog_pending").get()?.n, 0);
  sqlite.exec(
    "UPDATE knowledge_catalog_products SET verification_status='verified' WHERE id=900001",
  );
  const before = sqlite.prepare("SELECT * FROM product_search_catalog_pending").get();
  assert.equal(before?.listing_product_id, 51);
  sqlite.exec(`UPDATE product_identity_resolutions SET status='matched',catalog_product_id=900001,evaluated_at='later' WHERE listing_product_id=51;
    UPDATE knowledge_catalog_products SET verification_status='verified' WHERE id=900001;`);
  assert.deepEqual(sqlite.prepare("SELECT * FROM product_search_catalog_pending").get(), before);
  sqlite.exec(
    "UPDATE product_identity_resolutions SET status='unresolved',catalog_product_id=NULL WHERE listing_product_id=51",
  );
  match(sqlite);
  assert.notEqual(
    sqlite.prepare("SELECT token FROM product_search_catalog_pending").get()?.token,
    before?.token,
  );
  // Inserting an authoritative resolution after an interruption follows the same obligation path.
  sqlite.exec(
    "DELETE FROM product_identity_resolutions WHERE listing_product_id=51; DELETE FROM product_search_catalog_pending",
  );
  sqlite.exec(`INSERT INTO product_identity_resolutions(listing_product_id,status,catalog_product_id,match_method,confidence,evaluated_at)
    VALUES (51,'matched',900001,'test_catalog_match','high','${AT}')`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_search_catalog_pending").get()?.n, 1);
});

test("a budget interruption preserves the membership obligation for the next tick", async () => {
  const { db, sqlite } = fixture();
  match(sqlite);
  const budget = invocationBudget(db, { maxCalls: 4 });
  await assert.rejects(
    repairActiveListingProjectionGaps(budget.db, {
      evaluatedAt: AT,
      phases: "coverage",
      maxListings: 1,
    }),
    InvocationBudgetExceeded,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_search_catalog_pending").get()?.n, 1);
  const next = await repairActiveListingProjectionGaps(db, {
    evaluatedAt: AT,
    phases: "coverage",
    maxListings: 1,
  });
  assert.equal(next.repairedCount, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_search_catalog_pending").get()?.n, 0);
});

test("an older repair does not acknowledge a newer membership token", async () => {
  const { db, sqlite } = fixture();
  match(sqlite);
  const racing = asQueryableDatabase({
    ...db,
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.startsWith("DELETE FROM product_search_catalog_pending")) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async run() {
              sqlite.exec(
                "UPDATE product_search_catalog_pending SET token='newer' WHERE listing_product_id=51",
              );
              return bound.run();
            },
          };
        },
      };
    },
  });
  await repairActiveListingProjectionGaps(racing, {
    evaluatedAt: AT,
    phases: "coverage",
    maxListings: 1,
  });
  assert.equal(
    sqlite.prepare("SELECT token FROM product_search_catalog_pending").get()?.token,
    "newer",
  );
  await repairActiveListingProjectionGaps(db, {
    evaluatedAt: AT,
    phases: "coverage",
    maxListings: 1,
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_search_catalog_pending").get()?.n, 0);
});
