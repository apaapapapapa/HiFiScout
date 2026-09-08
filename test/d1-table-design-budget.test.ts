import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database } from "./helpers/d1-write-budget.js";
import { migrationSources } from "./helpers/migrations.js";
import { accountReads } from "../src/db/read-accounting.js";
import {
  refreshPublicMetaSnapshot,
  readPublicMetaSnapshot,
} from "../src/db/public-meta-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { createCompleteExportPlan, readCompleteExportPage } from "../src/export/complete-csv.js";

const AT = new Date("2030-01-01T00:00:00Z");
const counts = (accounting: ReturnType<typeof accountReads>) => ({
  reads: accounting.rowsRead(),
  writes: accounting.rowsWritten(),
  statements: accounting.statementCount(),
});
async function apply(db: QueryableDatabase, name: string) {
  return db
    .prepare(migrationSources.find((m) => m.name === name)!.sql.replace(/^\s*--[^\n]*$/gm, ""))
    .run();
}
async function fullRefresh(db: QueryableDatabase, now: Date) {
  await db
    .prepare(`INSERT INTO public_meta_snapshot(singleton, payload_json, generated_at)
    SELECT 1, payload_json, ? FROM public_meta_aggregate WHERE 1
    ON CONFLICT(singleton) DO UPDATE SET payload_json = excluded.payload_json, generated_at = excluded.generated_at`)
    .bind(now.toISOString())
    .run();
}

test("D1 category insert savings include retained indexes and override guards", async () => {
  const { db, dispose } = await database({ before: "0102_category_memberships_without_rowid.sql" });
  try {
    await db
      .prepare(`INSERT INTO products(id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at)
      VALUES (1, 'test', '1', 'test', 'https://example.test/1', '2026', '2026', '2026');
      INSERT INTO product_search_entities(id, entity_key, entity_kind, fallback_listing_id) VALUES (1, 'l-1', 'unresolved_listing', 1);
      INSERT INTO knowledge_catalog_products(id, manufacturer_id, canonical_model, normalized_model, created_at, updated_at)
      VALUES (999999, 'test', 'ONE', 'ONE', '2026', '2026');`)
      .run();
    const operations = [
      { table: "product_categories", id: 1 },
      { table: "product_search_entity_categories", id: 1 },
      { table: "knowledge_catalog_product_categories", id: 999999 },
    ];
    const before = [];
    for (const { table, id } of operations) {
      const result = await db
        .prepare(`INSERT INTO ${table} VALUES (?, 'AMP.PRE', 1)`)
        .bind(id)
        .run();
      before.push(Number(result.meta.rows_written));
    }
    await apply(db, "0102_category_memberships_without_rowid.sql");
    const after = [];
    for (const { table, id } of operations) {
      await db.prepare(`DELETE FROM ${table} WHERE category_id = 'AMP.PRE'`).run();
      const result = await db
        .prepare(`INSERT INTO ${table} VALUES (?, 'AMP.PRE', 1)`)
        .bind(id)
        .run();
      after.push(Number(result.meta.rows_written));
    }
    assert.deepEqual(before, [4, 3, 5]);
    assert.deepEqual(after, [3, 2, 4]);
    console.log(JSON.stringify({ event: "category_membership_d1_writes", before, after }));
    // Exercise the full schema inventory on actual D1: endpoint queries must respect its
    // compound-SELECT limit, and a page must not skip remaining categories of the same product.
    await db
      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1001)
      INSERT INTO product_categories SELECT 1, printf('CAT-%04d', i), 1 FROM n`)
      .run();
    const plan = await createCompleteExportPlan(db, "all", 1);
    const table = plan.tables.findIndex((entry) => entry.name === "product_categories");
    assert.equal(plan.version, 2);
    const first = await readCompleteExportPage(db, plan, { table, after: null });
    assert.equal(first.rows, 1000);
    assert.equal(first.next.table, table);
    await db.prepare("INSERT INTO product_categories VALUES(1, 'ZZ-after-horizon', 1)").run();
    const last = await readCompleteExportPage(db, plan, first.next);
    assert.equal(last.rows, 2);
    assert.equal(last.next.table, table + 1);
  } finally {
    await dispose();
  }
}, 30_000);

test("one identity index serves grouping and peer lookup with fewer D1 writes", async () => {
  const open = async (consolidated: boolean) => {
    const instance = await database({ before: "0111_consolidate_product_identity_indexes.sql" });
    if (consolidated) await apply(instance.db, "0111_consolidate_product_identity_indexes.sql");
    await instance.db
      .prepare(`INSERT INTO products(
        id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
        canonical_manufacturer_id, normalized_model, model_resolution_status
      ) VALUES (1, 'test', '1', 'C-10', 'https://example.test/1', '2026', '2026', '2026',
        'luxman', 'c10', 'resolved')`)
      .run();
    return instance;
  };
  const before = await open(false);
  const after = await open(true);
  try {
    const change = (db: QueryableDatabase) =>
      db
        .prepare("UPDATE products SET canonical_manufacturer_id = ? WHERE id = 1")
        .bind("luxman-audio")
        .run();
    const oldWrite = await change(before.db);
    const newWrite = await change(after.db);
    assert.ok(
      Number(newWrite.meta.rows_written) < Number(oldWrite.meta.rows_written),
      `identity update writes: ${JSON.stringify({ before: oldWrite.meta, after: newWrite.meta })}`,
    );
    console.log(
      JSON.stringify({
        event: "product_identity_index_d1_writes",
        before: oldWrite.meta.rows_written,
        after: newWrite.meta.rows_written,
      }),
    );
  } finally {
    await before.dispose();
    await after.dispose();
  }
}, 30_000);

test("the consolidated identity index excludes blank listings without increasing grouping reads", async () => {
  const open = async (consolidated: boolean) => {
    const instance = await database({ before: "0111_consolidate_product_identity_indexes.sql" });
    if (consolidated) await apply(instance.db, "0111_consolidate_product_identity_indexes.sql");
    await instance.db
      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
      INSERT INTO products(
        id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
        canonical_manufacturer_id, normalized_model, model_resolution_status
      )
      SELECT i, 'blank', CAST(i AS TEXT), 'blank', 'https://example.test/' || i,
        '2026', '2026', '2026', '', '', 'unresolved' FROM n;
      INSERT INTO products(
        id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
        canonical_manufacturer_id, normalized_model, model_resolution_status
      ) VALUES (10001, 'test', '10001', 'C-10', 'https://example.test/10001',
        '2026', '2026', '2026', 'luxman', 'c10', 'resolved');`)
      .run();
    return instance;
  };
  const before = await open(false);
  const after = await open(true);
  const grouping = (db: QueryableDatabase) =>
    db
      .prepare(`SELECT p.canonical_manufacturer_id, p.normalized_model, COUNT(*) AS listing_count
      FROM products p
      WHERE p.is_active = 1
        AND COALESCE(p.canonical_manufacturer_id, '') <> ''
        AND COALESCE(p.normalized_model, '') <> ''
      GROUP BY p.canonical_manufacturer_id, p.normalized_model
      ORDER BY listing_count DESC, p.canonical_manufacturer_id, p.normalized_model
      LIMIT 25`)
      .all();
  try {
    const oldRead = await grouping(before.db);
    const newRead = await grouping(after.db);
    assert.deepEqual(newRead.results, oldRead.results);
    assert.ok(
      Number(newRead.meta.rows_read) <= Number(oldRead.meta.rows_read),
      `blank identity grouping reads: ${JSON.stringify({ before: oldRead.meta, after: newRead.meta })}`,
    );
    console.log(
      JSON.stringify({
        event: "blank_identity_grouping_d1_reads",
        before: oldRead.meta.rows_read,
        after: newRead.meta.rows_read,
      }),
    );
  } finally {
    await before.dispose();
    await after.dispose();
  }
}, 30_000);

test("D1 metadata measures the complete refresh workload and bounded changed-entity work", async () => {
  for (const size of [1_000, 10_000]) {
    const { db, dispose } = await database({
      before: "0102_category_memberships_without_rowid.sql",
    });
    try {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${size})
        INSERT INTO products(id, shop_key, source_id, manufacturer, manufacturer_id, title, source_url,
          first_seen_at, last_seen_at, last_changed_at, primary_category_id)
        SELECT i, 'hifido', CAST(i AS TEXT), 'LUXMAN', 'luxman', 'C10', 'https://example.test/'||i,
          '2026', '2026', '2026', 'AMP.PRE' FROM n;
        INSERT INTO product_search_entities(id, entity_key, entity_kind, fallback_listing_id)
          SELECT id, 'l-'||id, 'unresolved_listing', id FROM products;
        INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
          SELECT id, id, shop_key FROM products;
        INSERT INTO product_search_entity_categories(entity_id, category_id, is_direct)
          SELECT id, 'AMP.PRE', 1 FROM products;
        INSERT INTO product_facet_facts(product_id, facet_id, facet_value, source)
          SELECT id, 'color', 'black', 'test' FROM products;`)
        .run();
      const change = async (target: QueryableDatabase, value: string) => {
        await target
          .prepare("UPDATE products SET metadata_json = ?, last_changed_at = ? WHERE id <= 100")
          .bind(JSON.stringify({ categoryClassification: { detailCheckedAt: value } }), value)
          .run();
        await target
          .prepare("UPDATE product_facet_facts SET facet_value = ? WHERE product_id <= 10")
          .bind(value)
          .run();
      };
      const old = accountReads(db);
      await change(old.db, "white");
      await fullRefresh(old.db, AT);
      const expected = await readPublicMetaSnapshot(db);
      await change(db, "black");
      await apply(db, "0102_category_memberships_without_rowid.sql");
      await apply(db, "0103_incremental_public_meta.sql");
      await db.prepare("UPDATE public_meta_snapshot SET generated_at = '2000-01-01'").run();
      const improved = accountReads(db);
      await change(improved.db, "white");
      assert.equal((await refreshPublicMetaSnapshot(improved.db, AT)).pending, false);
      assert.deepEqual(await readPublicMetaSnapshot(db), expected);
      assert.ok(
        improved.rowsRead() < old.rowsRead() / 2,
        `complete workload: ${JSON.stringify({ old: counts(old), improved: counts(improved) })}`,
      );
      // Include counter/dirty writes rather than inferring the workload cost from just SELECT.
      assert.ok(
        improved.rowsWritten() - old.rowsWritten() <= 60,
        `write cost: ${JSON.stringify({ old: counts(old), improved: counts(improved) })}`,
      );
      const idle = accountReads(db);
      await refreshPublicMetaSnapshot(idle.db, new Date(AT.getTime() + 3600_000));
      assert.ok(idle.rowsRead() < 100, `unchanged inventory read ${idle.rowsRead()} rows`);
      assert.equal(idle.rowsWritten(), 1);
      assert.equal(idle.countedStatements(), idle.statementCount());
      console.log(
        JSON.stringify({
          event: "incremental_meta_d1_budget",
          size,
          before: counts(old),
          after: counts(improved),
          idle: counts(idle),
        }),
      );
    } finally {
      await dispose();
    }
  }
}, 60_000);
