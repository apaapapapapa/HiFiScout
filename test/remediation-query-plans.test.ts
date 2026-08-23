import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

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
import {
  queryPlan,
  readsThroughIndex,
  recordingDatabase,
  unindexedScans,
} from "./helpers/query-plan.js";
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
 * An accepted row-by-row read, tied to the one statement that performs it.
 *
 * `when` is what keeps an exception honest. An allowance listed for the whole recorded workload
 * would also excuse a *different* query that starts scanning the same table, which is the opposite
 * of what this file is for.
 */
interface ScanAllowance {
  /** Table or alias, as the plan names it. */
  readonly tables: readonly string[];
  /** The statement the allowance covers. */
  readonly when: RegExp;
  readonly reason: string;
}

/**
 * Full table reads the schema does not yet avoid, measured rather than assumed.
 *
 * The list is empty: the queue claim and the replay seeding selector were the two entries, and
 * migration 0027 plus the selector rewrite removed both. It stays here because recording a new cost
 * is how this file absorbs one — a scan that cannot be fixed today gets an entry naming the exact
 * statement it covers, so the harness keeps failing on every *other* scan. Entries only ever leave.
 */
const KNOWN_UNINDEXED_READS: readonly ScanAllowance[] = [];

/**
 * The index each stage's staleness selector must reach, and the alias its plan names.
 *
 * Seeding is one statement per stage now, so this is what "one selector per resolver, each against
 * its own version index" looks like as an assertion. Reading through *some* index is not enough: a
 * planner free to pick `idx_products_active_ids` for the manufacturer selector would walk every
 * active listing to find the few that are behind, which is the cost the split exists to remove.
 */
const REQUIRED_SEED_INDEXES: readonly { readonly table: string; readonly index: string }[] = [
  { table: "p", index: "idx_products_active_manufacturer_version" },
  { table: "p", index: "idx_products_active_model_version" },
  { table: "p", index: "idx_products_active_category_version" },
  { table: "r", index: "idx_product_identity_resolver_version" },
  { table: "p", index: "idx_products_remediation_projection_required" },
];

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

/** Constant-size reference tables; reading one end to end costs nothing that grows. */
const SMALL_REFERENCE_TABLES = [
  "knowledge_catalog_products",
  "knowledge_catalog_product_categories",
  "knowledge_catalog_aliases",
  "knowledge_catalog_manufacturers",
  "knowledge_catalog_manufacturer_aliases",
];

/**
 * Asserts every statement a repository issued reads the growing tables through an index.
 *
 * Allowances are matched against each statement individually, so an exception granted for one query
 * cannot silently cover a different one that starts scanning the same table.
 */
function assertNoGrowingTableScans(
  sqlite: DatabaseSync,
  executed: readonly ExecutedStatement[],
  { allowances = [] as ScanAllowance[], label = "" } = {},
): void {
  const inspected = selects(executed);
  assert.ok(inspected.length > 0, `${label}: nothing was executed, so nothing was proven`);
  const applied = new Set<ScanAllowance>();
  for (const statement of inspected) {
    const matching = allowances.filter((allowance) => allowance.when.test(statement.sql));
    for (const allowance of matching) applied.add(allowance);
    const scans = unindexedScans(queryPlan(sqlite, statement), [
      ...SMALL_REFERENCE_TABLES,
      ...matching.flatMap((allowance) => allowance.tables),
    ]);
    assert.deepEqual(
      scans,
      [],
      `${label}: full table read of ${scans.join(", ")} in\n${statement.sql.trim()}`,
    );
  }
  // An allowance nobody needed is a fix that landed without its record being removed.
  for (const allowance of allowances) {
    assert.ok(
      applied.has(allowance),
      `${label}: no statement matched the recorded allowance for ${allowance.tables.join(", ")} — ` +
        "if the query no longer scans, delete the KNOWN_UNINDEXED_READS entry",
    );
  }
}

test("queue claiming walks one partial index per claimable state", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  seedListings(sqlite);
  const { db, executed } = recordingDatabase(inner);

  await seedDataQualityRemediationQueue(db, { now: "2026-08-15T00:00:00.000Z", limit: 10 });
  executed.length = 0;
  await claimDataQualityRemediationBatch(db, { claimedAt: "2026-08-15T00:00:00.000Z", limit: 5 });

  assertNoGrowingTableScans(sqlite, executed, {
    label: "claim",
    allowances: [...KNOWN_UNINDEXED_READS],
  });
  // Both halves have to be indexed, not just the one a fixture happens to populate: `pending` is
  // the common path, and `processing` is the one that reclaims an expired lease.
  const [claim] = selects(executed);
  assert.ok(claim, "claiming should issue a candidate query");
  const plan = queryPlan(sqlite, claim);
  for (const index of ["idx_dq_remediation_queue_pending", "idx_dq_remediation_queue_processing"]) {
    assert.ok(
      readsThroughIndex(plan, "data_quality_remediation_queue", index),
      `claiming must walk ${index}, got:\n${plan.map((step) => step.detail).join("\n")}`,
    );
  }
});

test("replay seeding reaches every stage through that stage's own index", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  seedListings(sqlite);
  const { db, executed } = recordingDatabase(inner);

  // Seeding is what runs the manufacturer/model/category/identity staleness selectors, which are
  // the queries that would otherwise read every listing on every five-minute cron tick.
  await seedDataQualityRemediationQueue(db, { now: "2026-08-15T00:00:00.000Z", limit: 10 });

  assertNoGrowingTableScans(sqlite, executed, {
    label: "seed",
    allowances: [...KNOWN_UNINDEXED_READS],
  });
  const plans = selects(executed).map((statement) => queryPlan(sqlite, statement));
  for (const { table, index } of REQUIRED_SEED_INDEXES) {
    assert.ok(
      plans.some((plan) => readsThroughIndex(plan, table, index)),
      `no seeding statement read ${table} through ${index}; plans were:\n${plans
        .map((plan) => plan.map((step) => step.detail).join(" | "))
        .join("\n")}`,
    );
  }

  // Reading through an index is not yet a bounded read. A sort between the index and the LIMIT means
  // every stale row is visited before any of them can be discarded, which is how a selector stays
  // proportional to the backlog while looking perfectly indexed — the exact shape the seeding
  // selectors were in before their `ORDER BY` was made to match the order their index delivers.
  for (const plan of plans) {
    const sorted = plan.filter((step) => /USE TEMP B-TREE FOR ORDER BY/.test(step.detail));
    assert.deepEqual(
      sorted.map((step) => step.detail),
      [],
      `a seeding selector sorts before its LIMIT, so the LIMIT cannot bound it:\n${plan
        .map((step) => step.detail)
        .join("\n")}`,
    );
  }
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

test("unresolved identity grouping walks the identity-group index, not the listing table", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  seedListings(sqlite);
  const { db, executed } = recordingDatabase(inner);

  await listUnresolvedIdentityGroups(db, 25);

  const [grouping, ...rest] = selects(executed);
  assert.equal(rest.length, 0, "grouping should be one statement, not a per-group lookup");
  const plan = queryPlan(sqlite, grouping);
  // `LIMIT` sits after GROUP BY here, so it bounds the rows returned but not the rows read. The
  // only thing that bounds the read is the index, which is what has to be asserted: drop
  // idx_products_identity_group and this becomes a full listing sweep on every dashboard load.
  assert.ok(
    readsThroughIndex(plan, "p", "idx_products_identity_group"),
    `grouping must read listings through idx_products_identity_group, got:\n${plan
      .map((step) => step.detail)
      .join("\n")}`,
  );
  assert.deepEqual(unindexedScans(plan, SMALL_REFERENCE_TABLES), []);
});

/**
 * The three shapes a search page takes, each measured on its own.
 *
 * Recording all three into one bucket would let an exception earned by the price sort excuse a new
 * scan in the text or filtered query, so every shape gets its own database and its own assertion.
 */
const SEARCH_SHAPES = [
  { label: "full text", search: "?q=TAD&includeTotal=true&limit=20" },
  { label: "price sort", search: "?sort=priceAsc&limit=20" },
  { label: "filters", search: "?manufacturer=tad&category=dac&inStock=true&limit=20" },
] as const;

for (const shape of SEARCH_SHAPES) {
  test(`a ${shape.label} search page reads no table row by row`, async () => {
    const { sqlite, db: inner } = migratedSqlite();
    seedListings(sqlite);
    // The search read model has to exist before its plans mean anything: explaining a query against
    // an empty table describes the empty table, not production. Measuring the price sort against an
    // empty `product_search_entities` is what previously made it look like it ignored its index.
    await refreshListingProjections(
      inner,
      Array.from({ length: LISTING_COUNT }, (_, i) => ({
        shop_key: `shop-${i % 4}`,
        source_id: `source-${i}`,
      })),
      "2026-08-15T00:00:00.000Z",
    );
    const { db, executed } = recordingDatabase(inner);

    await searchProducts(db, productQuery(shape.search));

    assertNoGrowingTableScans(sqlite, executed, { label: shape.label });
  });
}
