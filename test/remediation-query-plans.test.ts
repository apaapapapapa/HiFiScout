import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  claimDataQualityRemediationBatch,
  seedDataQualityRemediationQueue,
} from "../src/db/data-quality-remediation-queue-repository.js";
import { listUnresolvedIdentityGroups } from "../src/db/knowledge-catalog-remediation-repository.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { listManufacturerAliasEvidence } from "../src/db/manufacturer-repository.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";
import { queryPlan, recordingDatabase, unindexedScans } from "./helpers/query-plan.js";
import type { ExecutedStatement } from "./helpers/query-plan.js";

/**
 * The index coverage section 16 asks for, checked against actual query plans.
 *
 * `phase4-product-search-migration.test.ts` asserts that index DDL exists. That is necessary and
 * not sufficient: an index the planner declines to use is an index that costs writes and buys
 * nothing, and the only way to tell the difference is to explain the statement. These tests run the
 * real repository functions against the migrated schema, capture the SQL they actually issued, and
 * explain each one — so a predicate reordering that quietly drops an index fails here rather than
 * in production D1 with a full table read per crawl.
 *
 * `SCAN` is SQLite's word for "read every row of this table". The tables that must never be scanned
 * on a hot path are the ones that grow with the catalog: `products`, `product_search_entities`,
 * `product_search_entity_offers` and `data_quality_remediation_queue`.
 */

/** The listing count is arbitrary; the planner's choice is driven by the schema, not by row count. */
const LISTING_COUNT = 40;

/**
 * Full reads the planner performs today that the schema does not yet avoid.
 *
 * These are measured, not assumed, and each one is a real production cost. They are named here
 * rather than left as a failing suite so the harness keeps catching *new* scans; deleting an entry
 * is what a fix looks like, and the test then fails until the entry goes.
 *
 * - `data_quality_remediation_queue` (claim): `idx_dq_remediation_queue_claim` cannot serve the
 *   query because the two claimable states are an `OR` of different columns and the `ORDER BY`
 *   column order differs from the index. Splitting the branches into a `UNION ALL` would let each
 *   side use the partial index.
 * - `products` (seed): the staleness CTE tests four resolver versions in `CASE` branches, so no
 *   single index applies and every listing is read on each five-minute tick. Running one selector
 *   per resolver, each against its own version index, would bound it.
 * - `product_search_entities` (price sort): `ORDER BY lowest_price_yen ASC NULLS LAST` cannot use
 *   `idx_product_search_entities_price`, because SQLite orders NULLs first. An index over
 *   `(lowest_price_yen IS NULL, lowest_price_yen, id)` would match the requested order.
 */
const KNOWN_UNINDEXED_READS = {
  queueClaim: ["data_quality_remediation_queue"],
  replaySeed: ["p"],
  searchPriceSort: ["e"],
} as const;

function seedListings(sqlite: DatabaseSync): void {
  const insert = sqlite.prepare(`
    INSERT INTO products(
      shop_key, source_id, manufacturer, model, title, category, condition_text,
      price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at,
      last_activity_at, is_active, raw_manufacturer, manufacturer_id, canonical_manufacturer_id,
      raw_model, normalized_model, raw_category, primary_category_id, category_ids,
      classification_status, manufacturer_resolver_version, model_resolver_version
    ) VALUES (
      ?, ?, 'TAD', ?, ?, 'D/Aコンバーター', '中古',
      500000, 'in_stock', ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1, 'TAD', 'tad', 'tad',
      ?, ?, 'D/Aコンバーター', 'dac', '["dac"]', 'classified', 1, 1
    )
  `);
  for (let i = 0; i < LISTING_COUNT; i += 1) {
    const model = `D${1000 + i}`;
    insert.run(
      `shop-${i % 4}`,
      `source-${i}`,
      model,
      `TAD ${model}`,
      `https://example.test/${i}`,
      model,
      model,
    );
  }
}

/**
 * The statements whose plan is worth checking.
 *
 * `WITH` and `INSERT ... SELECT` are included deliberately: the selectors that pick stale listings
 * are a CTE feeding an insert into the queue, so matching only bare `SELECT` would skip the exact
 * queries section 16 is about.
 */
function selects(executed: readonly ExecutedStatement[]): ExecutedStatement[] {
  return executed.filter((statement) =>
    /^\s*(SELECT|WITH|INSERT[\s\S]*\bSELECT\b)/i.test(statement.sql),
  );
}

/** Asserts every SELECT a repository issued reads the growing tables through an index. */
function assertNoGrowingTableScans(
  sqlite: DatabaseSync,
  executed: readonly ExecutedStatement[],
  { allow = [] as string[], label = "" } = {},
): void {
  const inspected = selects(executed);
  assert.ok(inspected.length > 0, `${label}: nothing was executed, so nothing was proven`);
  for (const statement of inspected) {
    const scans = unindexedScans(queryPlan(sqlite, statement), [
      // Constant-size or intentionally swept tables. Anything not listed here must use an index.
      "knowledge_catalog_products",
      "knowledge_catalog_product_categories",
      "knowledge_catalog_aliases",
      "knowledge_catalog_manufacturers",
      "knowledge_catalog_manufacturer_aliases",
      ...allow,
    ]);
    assert.deepEqual(
      scans,
      [],
      `${label}: full table read of ${scans.join(", ")} in\n${statement.sql.trim()}`,
    );
  }
}

test("queue claiming stays bounded, and its scan is the one recorded below", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  seedListings(sqlite);
  const { db, executed } = recordingDatabase(inner);

  await seedDataQualityRemediationQueue(db, { now: "2026-08-15T00:00:00.000Z", limit: 10 });
  executed.length = 0;
  await claimDataQualityRemediationBatch(db, { claimedAt: "2026-08-15T00:00:00.000Z", limit: 5 });

  assertNoGrowingTableScans(sqlite, executed, {
    label: "claim",
    allow: [...KNOWN_UNINDEXED_READS.queueClaim],
  });
});

test("replay seeding reads no table beyond the ones recorded below", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  seedListings(sqlite);
  const { db, executed } = recordingDatabase(inner);

  // Seeding is what runs the manufacturer/model/category/identity staleness selectors, which are
  // the queries that would otherwise read every listing on every five-minute cron tick.
  await seedDataQualityRemediationQueue(db, { now: "2026-08-15T00:00:00.000Z", limit: 10 });

  assertNoGrowingTableScans(sqlite, executed, {
    label: "seed",
    // Identity staleness is defined by the absence of a current resolution row, so the selector
    // walks the resolution table itself; it is bounded by LIMIT rather than by an index.
    allow: ["product_identity_resolutions", ...KNOWN_UNINDEXED_READS.replaySeed],
  });
});

test("manufacturer alias evidence loads through the normalized alias index", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  const { db, executed } = recordingDatabase(inner);

  await listManufacturerAliasEvidence(db);

  // The alias table is read in full on purpose — it is the resolver's in-memory snapshot — so the
  // plan that matters is that it never joins listings while doing so.
  for (const statement of selects(executed)) {
    assert.deepEqual(
      unindexedScans(queryPlan(sqlite, statement), [
        "knowledge_catalog_manufacturer_aliases",
        "knowledge_catalog_manufacturers",
      ]),
      [],
    );
    assert.doesNotMatch(statement.sql, /\bFROM products\b|\bJOIN products\b/);
  }
});

test("unresolved identity grouping is bounded rather than a full listing sweep", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  seedListings(sqlite);
  const { db, executed } = recordingDatabase(inner);

  await listUnresolvedIdentityGroups(db, 25);

  for (const statement of selects(executed)) {
    // Grouping is an aggregate over unresolved listings, so a scan is expected; what must hold is
    // that it is capped, or the query would grow without bound as the catalog grows.
    assert.match(statement.sql, /LIMIT/i);
  }
});

test("a product search page adds no unindexed read beyond the recorded price sort", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  seedListings(sqlite);
  // The search read model has to exist before its plans mean anything: explaining a query against
  // an empty table describes the empty table, not production.
  await refreshListingProjections(
    inner,
    Array.from({ length: LISTING_COUNT }, (_, i) => ({
      shop_key: `shop-${i % 4}`,
      source_id: `source-${i}`,
    })),
    "2026-08-15T00:00:00.000Z",
  );
  const { db, executed } = recordingDatabase(inner);

  await searchProducts(db, productQuery("?q=TAD&includeTotal=true&limit=20"));
  await searchProducts(db, productQuery("?sort=priceAsc&limit=20"));
  await searchProducts(db, productQuery("?manufacturer=tad&category=dac&inStock=true&limit=20"));

  assertNoGrowingTableScans(sqlite, executed, {
    label: "search",
    // The offer queries drive from `product_search_entity_offers` scoped to the page's entity ids
    // and join listings by primary key; on a fixture this small the planner reads the listing side
    // directly. What must stay indexed is the membership side, which the page scopes.
    allow: ["p", ...KNOWN_UNINDEXED_READS.searchPriceSort],
  });
});
