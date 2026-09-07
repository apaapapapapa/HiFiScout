import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";

test("category table replacement preserves rows, guards, primary uniqueness and cascades", () => {
  const { sqlite } = migratedSqlite({ before: "0102_category_memberships_without_rowid.sql" });
  try {
    sqlite.exec(`PRAGMA foreign_keys = ON;
      INSERT INTO products(id, shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at)
      VALUES (1, 'test', '1', 'test', 'https://example.test/1', '2026', '2026', '2026');
      INSERT INTO product_categories(product_id, category_id, is_direct) VALUES (1, 'AMP', 0), (1, 'AMP.PRE', 1);
      INSERT INTO product_admin_overrides(listing_product_id, primary_category_id, category_ids, created_at, updated_at)
      VALUES (1, 'AMP.PRE', '["AMP","AMP.PRE"]', '2026', '2026');
      INSERT INTO product_search_entities(id, entity_key, entity_kind, fallback_listing_id)
      VALUES (1, 'l-1', 'unresolved_listing', 1);
      INSERT INTO product_search_entity_categories(entity_id, category_id, is_direct) VALUES (1, 'AMP.PRE', 1);
      INSERT INTO knowledge_catalog_products(id, manufacturer_id, canonical_model, normalized_model, created_at, updated_at)
      VALUES (999999, 'test', 'ONE', 'ONE', '2026', '2026');
      INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
      VALUES (999999, 'AMP', 0), (999999, 'AMP.PRE', 1);`);
    const tables = [
      "product_categories",
      "product_search_entity_categories",
      "knowledge_catalog_product_categories",
    ];
    const before = tables.map((table) =>
      sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all(),
    );
    const aggregate = sqlite
      .prepare("SELECT payload_json FROM public_meta_aggregate")
      .get()?.payload_json;
    sqlite.exec("BEGIN");
    sqlite.exec(
      migrationSources.find((m) => m.name === "0102_category_memberships_without_rowid.sql")!.sql,
    );
    sqlite.exec("COMMIT");
    assert.deepEqual(
      tables.map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()),
      before,
    );
    assert.equal(
      sqlite.prepare("SELECT payload_json FROM public_meta_aggregate").get()?.payload_json,
      aggregate,
    );
    for (const table of tables) {
      assert.match(
        String(sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(table)?.sql),
        /WITHOUT ROWID/,
      );
    }
    sqlite.exec(
      "DELETE FROM product_categories WHERE product_id = 1; INSERT INTO product_categories(product_id, category_id) VALUES (1, 'SPK')",
    );
    assert.deepEqual(
      sqlite.prepare("SELECT * FROM product_categories ORDER BY 1,2").all(),
      before[0],
    );
    assert.throws(
      () =>
        sqlite.exec("INSERT INTO knowledge_catalog_product_categories VALUES (999999, 'SPK', 1)"),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        sqlite.exec("INSERT INTO knowledge_catalog_product_categories VALUES (999999, 'SPK', 2)"),
      /CHECK/,
    );
    assert.throws(
      () => sqlite.exec("INSERT INTO product_search_entity_categories VALUES (999999, 'AMP', 1)"),
      /FOREIGN KEY/,
    );
    sqlite.exec(
      "DELETE FROM products WHERE id = 1; DELETE FROM knowledge_catalog_products WHERE id = 999999",
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_categories").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_admin_overrides").get()?.n, 0);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) n FROM product_search_entity_categories").get()?.n,
      0,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) n FROM knowledge_catalog_product_categories WHERE product_id = 999999",
        )
        .get()?.n,
      0,
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
  }
});
