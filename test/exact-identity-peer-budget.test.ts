import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { compatibleExactIdentityCategoriesSql } from "../src/db/product-search-entity-sql.js";
import { exactIdentityPeerIdsSql } from "../src/db/product-search-exact-identity.js";
import { syncProductSearchEntities } from "../src/db/product-search-entity-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { AT, database } from "./helpers/d1-write-budget.js";

test("exact peer lookup stays identity-scoped as unrelated categories and listings grow", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
        INSERT INTO products(id, shop_key, source_id, canonical_manufacturer_id, model,
          normalized_model, model_resolution_status, primary_category_id, title, source_url,
          first_seen_at, last_seen_at, last_changed_at)
        SELECT i, CASE WHEN i % 2 = 1 THEN 'hifido' ELSE 'audiounion' END, CAST(i AS TEXT),
          'luxman', 'C10', 'C10', 'resolved', 'AMP.PRE', 'LUXMAN C10',
          'https://example.test/' || i, '${AT}', '${AT}', '${AT}' FROM n
      `)
      .run();
    const sql = exactIdentityPeerIdsSql(1);
    const expected = [1, 2, 3, 4, 5];
    const peers = async (): Promise<number[]> => {
      const result = await db.prepare(sql).bind(1).all<{ id: number }>();
      const rows: { id: number }[] = result.results || [];
      return rows.map((row) => row.id).sort((a, b) => a - b);
    };
    const costs: { size: number; rowsRead: number; rowsWritten: number; statements: number }[] = [];
    let previous = 5;
    for (const size of [100, 1_000, 10_000]) {
      // Both identity columns matter: same maker/different model and different maker/same model.
      // A second specific category exposes the old uncorrelated aggregate's false rejection.
      await db
        .prepare(`
          WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?)
          INSERT INTO products(id, shop_key, source_id, canonical_manufacturer_id, model,
            normalized_model, model_resolution_status, primary_category_id, title, source_url,
            first_seen_at, last_seen_at, last_changed_at)
          SELECT i, 'unrelated', CAST(i AS TEXT),
            CASE WHEN i % 2 = 0 THEN 'luxman' ELSE 'yamaha' END, 'unrelated',
            CASE WHEN i % 2 = 0 THEN 'UNRELATED-' || i ELSE 'C10' END,
            'resolved', 'AMP.INTEGRATED', 'unrelated', 'https://example.test/' || i,
            '${AT}', '${AT}', '${AT}' FROM n
        `)
        .bind(previous + 1, size)
        .run();
      const measured = accountReads(db);
      const result = await measured.db.prepare(sql).bind(1).all<{ id: number }>();
      assert.deepEqual(
        (result.results || []).map((row) => row.id).sort((a, b) => a - b),
        expected,
        `peer membership at ${size} listings`,
      );
      assert.equal(measured.countedStatements(), 1);
      assert.equal(measured.rowsWritten(), 0);
      assert.ok(measured.rowsRead() < 300, `${size} listings read ${measured.rowsRead()} rows`);
      costs.push({
        size,
        rowsRead: measured.rowsRead(),
        rowsWritten: measured.rowsWritten(),
        statements: measured.countedStatements(),
      });
      previous = size;
    }
    assert.equal(new Set(costs.map((cost) => cost.rowsRead)).size, 1);
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(1).all<{ detail: string }>();
    const planRows: { detail: string }[] = plan.results || [];
    assert.ok(
      planRows.some((row) =>
        /SEARCH peer_category_peer .*canonical_manufacturer_id=\? AND normalized_model=\?/.test(
          row.detail,
        ),
      ),
      JSON.stringify(planRows),
    );
    console.log(JSON.stringify({ event: "exact_identity_peer_read_budget", costs, plan: planRows }));

    // Exercise the helper with the caller alias that caused the bug, and with its old/local names.
    for (const alias of ["p", "peer", "category_peer", "peer_category_peer"]) {
      const row = await db
        .prepare(`SELECT ${compatibleExactIdentityCategoriesSql(alias)} AS compatible
          FROM products ${alias} WHERE ${alias}.id = ?`)
        .bind(1)
        .first<{ compatible: number }>();
      assert.equal(row?.compatible, 1, alias);
    }

    // A single-shop seed must repair peers in another shop, not only create its own correct card.
    await db
      .prepare(`
        INSERT INTO product_search_entities(entity_key, entity_kind, fallback_listing_id, manufacturer_id, model)
        SELECT 'l-' || id, 'unresolved_listing', id, 'luxman', 'C10' FROM products WHERE id <= 5;
        INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key)
        SELECT p.id, e.id, p.shop_key FROM products p
        JOIN product_search_entities e ON e.fallback_listing_id = p.id WHERE p.id <= 5;
      `)
      .run();
    await syncProductSearchEntities(db, "hifido", ["1"]);
    const entities = await db
      .prepare("SELECT entity_key, offer_count, shop_count FROM product_search_entities")
      .all();
    assert.deepEqual(entities.results, [{ entity_key: "l-1", offer_count: 5, shop_count: 2 }]);
    const replay = accountReads(db);
    await syncProductSearchEntities(replay.db, "hifido", ["1"]);
    assert.equal(replay.rowsWritten(), 0);
    assert.ok(replay.rowsRead() < 2_000, `scoped replay read ${replay.rowsRead()} rows`);

    // Genuine contradictions still veto the group; missing specificity does not.
    await db
      .prepare("UPDATE products SET primary_category_id = 'AMP.INTEGRATED' WHERE id = 5")
      .run();
    assert.deepEqual(await peers(), []);
    for (const category of ["unclassified", "other"]) {
      await db
        .prepare("UPDATE products SET primary_category_id = ? WHERE id = 5")
        .bind(category)
        .run();
      assert.deepEqual(await peers(), expected);
    }
    await db
      .prepare(
        "UPDATE products SET primary_category_id = 'AMP.INTEGRATED', is_active = 0 WHERE id = 5",
      )
      .run();
    assert.deepEqual(await peers(), [1, 2, 3, 4]);
    await db
      .prepare(
        "UPDATE products SET is_active = 1, model_resolution_status = 'candidate' WHERE id = 5",
      )
      .run();
    assert.deepEqual(await peers(), [1, 2, 3, 4]);
    await db.prepare("UPDATE products SET model_resolution_status = 'resolved' WHERE id = 5").run();
    await db
      .prepare(`INSERT INTO product_identity_resolutions(listing_product_id, status, match_method, confidence, evaluated_at)
        VALUES (5, 'unresolved', 'vetoed', 'none', '${AT}')`)
      .run();
    assert.deepEqual(await peers(), [1, 2, 3, 4]);
    await db
      .prepare(`INSERT INTO knowledge_catalog_products(id, manufacturer_id, canonical_model, normalized_model,
        canonical_name, verification_status, created_at, updated_at)
        VALUES (1, 'luxman', 'C10', 'C10', 'LUXMAN C10', 'verified', '${AT}', '${AT}');
        UPDATE product_identity_resolutions SET status = 'matched', match_method = 'catalog_alias',
          catalog_product_id = 1 WHERE listing_product_id = 5;`)
      .run();
    assert.deepEqual(await peers(), [1, 2, 3, 4]);
  } finally {
    await dispose();
  }
}, 60_000);
