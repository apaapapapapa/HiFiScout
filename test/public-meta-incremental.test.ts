import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  refreshPublicMetaSnapshot,
  readPublicMetaSnapshot,
  PUBLIC_META_MAX_PAGES,
} from "../src/db/public-meta-repository.js";
import { refreshPublicMetaFacets, PUBLIC_META_ENTITY_PAGE } from "../src/db/public-meta-facets.js";
import { invocationBudget, InvocationBudgetExceeded } from "../src/db/invocation-budget.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";
import type { PublicMetaSnapshot } from "../src/db/public-meta-repository.js";

const AT = new Date("2030-01-01T00:00:00Z");
const seed = `
  INSERT INTO products(id, shop_key, source_id, manufacturer, manufacturer_id, title, source_url,
    first_seen_at, last_seen_at, last_changed_at, primary_category_id, metadata_json)
  VALUES (1, 'hifido', 'one', 'LUXMAN', 'luxman', 'one', 'https://example.test/1', '2026', '2026', '2026',
    'unclassified', '{"categoryClassification":{"confidence":0.5}}'),
    (2, 'audioshop', 'two', 'Luxman', 'luxman', 'two', 'https://example.test/2', '2026', '2026', '2026',
    'other', '{}');
  INSERT INTO product_search_entities(id, entity_key, entity_kind, fallback_listing_id)
  VALUES (1, 'l-1', 'unresolved_listing', 1), (2, 'l-2', 'unresolved_listing', 2);
  INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
  VALUES (1, 1, 'hifido'), (2, 1, 'audioshop');
  INSERT INTO product_search_entity_categories(entity_id, category_id, is_direct)
  VALUES (1, 'AMP.PRE', 1), (1, 'AMP', 0);
  INSERT INTO product_facet_facts(product_id, facet_id, facet_value, source, confidence)
  VALUES (1, 'color', 'black', 'seller', 1), (1, 'color', 'black', 'model', 1),
    (2, 'color', 'black', 'seller', 1);
  INSERT INTO taxonomy_v3_migration_audit(entity_type, entity_id, category_position,
    legacy_category_id, canonical_category_id, mapping_strategy, confidence)
  VALUES ('product_primary', 1, 0, 'pre_amp', 'AMP.PRE', 'test', 1),
    ('product_primary', 1, 1, 'amplifier', 'AMP', 'test', 1);
`;

function canonical(batches: PublicMetaSnapshot["batches"]) {
  return batches.map(({ results }) => results.map((row) => JSON.stringify(row)).sort());
}

test("incremental metadata matches the full aggregate across migration and source transitions", async () => {
  const { sqlite, db } = migratedSqlite({ before: "0103_incremental_public_meta.sql" });
  try {
    sqlite.exec(seed);
    sqlite.exec(migrationSources.find((m) => m.name === "0103_incremental_public_meta.sql")!.sql);
    const transitions = [
      "SELECT 1", // The migration backfill must include existing data without waiting for a dirty event.
      "UPDATE products SET manufacturer = 'AAA' WHERE id = 2",
      "UPDATE products SET manufacturer_id = 'other-maker', manufacturer = 'Other' WHERE id = 1",
      "UPDATE products SET manufacturer = '' WHERE id = 2",
      "UPDATE products SET shop_key = 'changed', primary_category_id = 'AMP.PRE', metadata_json = '{\"categoryClassification\":{\"confidence\":1}}' WHERE id = 1",
      'UPDATE products SET metadata_json = \'{"categoryClassification":{"confidence":0.2}}\' WHERE id = 2',
      "UPDATE product_search_entity_categories SET category_id = 'AMP.POWER' WHERE category_id = 'AMP.PRE'",
      "INSERT OR REPLACE INTO product_facet_facts(product_id, facet_id, facet_value, source, confidence) VALUES (1, 'color', 'black', 'seller', 0.8)",
      "DELETE FROM product_facet_facts WHERE product_id = 1 AND source = 'model'",
      "DELETE FROM product_facet_facts WHERE product_id = 1",
      "UPDATE product_search_entity_offers SET entity_id = 2 WHERE listing_product_id = 2",
      "UPDATE product_facet_facts SET facet_value = 'silver' WHERE product_id = 2",
      "UPDATE products SET is_active = 0 WHERE id = 2",
      "UPDATE products SET is_active = 1, manufacturer = 'LUXMAN' WHERE id = 2",
      "UPDATE taxonomy_v3_migration_audit SET canonical_category_id = legacy_category_id WHERE category_position = 0",
      "DELETE FROM taxonomy_v3_migration_audit WHERE category_position = 1",
      "DELETE FROM product_search_entities WHERE id = 2",
      "DELETE FROM products WHERE id = 1",
      "DELETE FROM products WHERE id = 2",
      "DELETE FROM taxonomy_v3_migration_audit",
      seed,
    ];
    for (const transition of transitions) {
      sqlite.exec(transition);
      sqlite.exec("UPDATE public_meta_snapshot SET generated_at = '2000-01-01'");
      const result = await refreshPublicMetaSnapshot(db, AT);
      assert.equal(result.pending, false, transition);
      assert.equal(result.refreshed, true, transition);
      const expected = JSON.parse(
        String(
          sqlite.prepare("SELECT payload_json FROM public_meta_aggregate").get()?.payload_json,
        ),
      );
      assert.deepEqual(
        canonical((await readPublicMetaSnapshot(db)).batches),
        canonical(expected),
        transition,
      );
      assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(
        sqlite
          .prepare(
            "SELECT COUNT(*) n FROM public_meta_counts WHERE kind <> 'taxonomy' AND row_count = 0",
          )
          .get()?.n,
        0,
        "retired vocabulary must not accumulate in future snapshot scans",
      );
    }
  } finally {
    sqlite.close();
  }
});

test("a bounded facet backlog retains the complete snapshot until its last page, including retries", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    await refreshPublicMetaSnapshot(db, AT);
    const previous = await readPublicMetaSnapshot(db);
    const fullPage = PUBLIC_META_ENTITY_PAGE * PUBLIC_META_MAX_PAGES;
    sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${fullPage + 1})
      INSERT INTO products(id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at)
      SELECT i, 'hifido', CAST(i AS TEXT), 'test', 'https://example.test/'||i, '2026', '2026', '2026' FROM n;
      INSERT INTO product_search_entities(id, entity_key, entity_kind, fallback_listing_id)
        SELECT id, 'l-'||id, 'unresolved_listing', id FROM products;
      INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
        SELECT id, id, shop_key FROM products;
      INSERT INTO product_facet_facts(product_id, facet_id, facet_value, source)
        SELECT id, 'color', 'black', 'test' FROM products;`);
    const due = new Date(AT.getTime() + 3600_000);
    assert.deepEqual(await refreshPublicMetaSnapshot(db, due), {
      refreshed: false,
      pending: true,
      processedEntities: fullPage,
    });
    assert.deepEqual(await readPublicMetaSnapshot(db), previous);
    sqlite.exec(
      "CREATE TRIGGER fail_facet BEFORE INSERT ON public_meta_entity_facets BEGIN SELECT RAISE(ABORT, 'facet failure'); END",
    );
    await assert.rejects(refreshPublicMetaSnapshot(db, due), /facet failure/);
    assert.deepEqual(await readPublicMetaSnapshot(db), previous);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM public_meta_dirty_entities").get()?.n, 1);
    sqlite.exec("DROP TRIGGER fail_facet");
    assert.deepEqual(await refreshPublicMetaSnapshot(db, due), {
      refreshed: true,
      pending: false,
      processedEntities: 1,
    });
    assert.equal(
      (await readPublicMetaSnapshot(db)).batches[2]?.results[0]?.active_product_count,
      fullPage + 1,
    );
    assert.equal((await refreshPublicMetaSnapshot(db, due)).refreshed, false);
  } finally {
    sqlite.close();
  }
});

test("facet acknowledgement includes changes after page selection and rolls back with its effects", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(seed);
    let changed = false;
    const concurrent = {
      prepare: db.prepare.bind(db),
      async batch<T>(statements: D1PreparedStatement[]) {
        if (!changed) {
          changed = true;
          sqlite.exec("UPDATE product_facet_facts SET facet_value = 'silver'");
        }
        return db.batch<T>(statements);
      },
    };
    await refreshPublicMetaFacets(concurrent);
    assert.deepEqual(
      sqlite
        .prepare("SELECT DISTINCT facet_value FROM public_meta_entity_facets")
        .all()
        .map((r) => r.facet_value),
      ["silver"],
    );
    sqlite.exec(
      "UPDATE product_facet_facts SET facet_value = 'white'; CREATE TRIGGER fail_ack BEFORE DELETE ON public_meta_dirty_entities BEGIN SELECT RAISE(ABORT, 'ack failure'); END",
    );
    await assert.rejects(refreshPublicMetaFacets(db), /ack failure/);
    assert.deepEqual(
      sqlite
        .prepare("SELECT DISTINCT facet_value FROM public_meta_entity_facets")
        .all()
        .map((r) => r.facet_value),
      ["silver"],
    );
    sqlite.exec("DROP TRIGGER fail_ack");
    await refreshPublicMetaSnapshot(db, AT);
    const expected = JSON.parse(
      String(sqlite.prepare("SELECT payload_json FROM public_meta_aggregate").get()?.payload_json),
    );
    assert.deepEqual(canonical((await readPublicMetaSnapshot(db)).batches), canonical(expected));
  } finally {
    sqlite.close();
  }
});

test("metadata work yields before touching counters when the invocation cannot fit a complete page", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(seed);
    const before = sqlite.prepare("SELECT * FROM public_meta_counts").all();
    const budget = invocationBudget(db, { maxCalls: 2 });
    await assert.rejects(refreshPublicMetaSnapshot(budget.db, AT), InvocationBudgetExceeded);
    assert.equal(budget.metrics().d1Calls, 0);
    assert.deepEqual(sqlite.prepare("SELECT * FROM public_meta_counts").all(), before);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM public_meta_dirty_entities").get()?.n, 1);
  } finally {
    sqlite.close();
  }
});

test("manual authority corrections keep counters exact regardless of AFTER trigger order", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(seed);
    sqlite.exec(`INSERT INTO product_admin_overrides(listing_product_id,manufacturer_id,manufacturer_name,created_at,updated_at)
      VALUES(1,'luxman','LUXMAN','2026','2026')`);
    for (const reorder of [false, true]) {
      if (reorder) {
        const sql = String(
          sqlite
            .prepare(
              "SELECT sql FROM sqlite_schema WHERE name='product_admin_overrides_products_au'",
            )
            .get()?.sql,
        );
        sqlite.exec("DROP TRIGGER product_admin_overrides_products_au");
        sqlite.exec(sql);
      }
      sqlite.exec(
        "UPDATE products SET manufacturer='TAD',manufacturer_id='tad' WHERE id=1; UPDATE public_meta_snapshot SET generated_at='2000-01-01'",
      );
      await refreshPublicMetaSnapshot(db, AT);
      const expected = JSON.parse(
        String(
          sqlite.prepare("SELECT payload_json FROM public_meta_aggregate").get()?.payload_json,
        ),
      );
      assert.deepEqual(
        canonical((await readPublicMetaSnapshot(db)).batches),
        canonical(expected),
        `reordered=${reorder}`,
      );
    }
  } finally {
    sqlite.close();
  }
});
