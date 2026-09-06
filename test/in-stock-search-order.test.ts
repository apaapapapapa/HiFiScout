import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { refreshEntityAggregatesSql } from "../src/db/product-search-entity-sql.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";
import { productQuery } from "./helpers/product-query.js";

test("in-stock date migration, cursors and refresh ignore newer unavailable offers", async () => {
  const migration = migrationSources.find((row) => row.name === "0096_in_stock_search_order.sql");
  assert.ok(migration);
  const { db, sqlite } = migratedSqlite({ before: migration.name });
  try {
    sqlite.exec(`INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,first_seen_at,last_seen_at,last_changed_at,last_activity_at,is_active) VALUES
      (1,'a','1','A','https://example.test/1','in_stock','2026-09-01','2026-09-01','2026-09-01','2026-09-01',1),
      (2,'b','2','A sold','https://example.test/2','sold_out','2026-09-06','2026-09-06','2026-09-06','2026-09-06',1),
      (3,'a','3','B','https://example.test/3','in_stock','2026-09-02','2026-09-02','2026-09-02','2026-09-02',1),
      (4,'b','4','B inactive','https://example.test/4','in_stock','2026-09-07','2026-09-07','2026-09-07','2026-09-07',0),
      (5,'a','5','C unknown','https://example.test/5','unknown','2026-09-08','2026-09-08','2026-09-08','2026-09-08',1);
      INSERT INTO product_search_entities(id,entity_key,entity_kind,fallback_listing_id,offer_count,in_stock_offer_count)
      VALUES(1,'l-1','unresolved_listing',1,2,1),(2,'l-3','unresolved_listing',3,1,1),(3,'l-5','unresolved_listing',5,1,0);
      INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
      VALUES(1,1,'a'),(2,1,'b'),(3,2,'a'),(4,2,'b'),(5,3,'a');`);
    sqlite.exec(migration.sql);
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT newest_in_stock_listed_at AS newest, latest_in_stock_activity_at AS activity FROM product_search_entities ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { newest: "2026-09-01", activity: "2026-09-01" },
        { newest: "2026-09-02", activity: "2026-09-02" },
        { newest: null, activity: null },
      ],
    );
    for (const sort of ["newest", "updated", "oldest"]) {
      const first = await searchProducts(
        db,
        productQuery(`?inStock=true&sort=${sort}&limit=1&includeTotal=true`),
      );
      assert.equal(first.totalCount, 2);
      assert.equal(first.items[0].key, sort === "oldest" ? "l-1" : "l-3");
      assert.ok(first.nextCursor);
      const second = await searchProducts(
        db,
        productQuery(
          `?inStock=true&sort=${sort}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        ),
      );
      assert.equal(second.items[0].key, sort === "oldest" ? "l-3" : "l-1");
      assert.equal(second.hasMore, false);
    }
    sqlite.exec("UPDATE products SET stock_status='sold_out' WHERE id=3");
    await db.prepare(refreshEntityAggregatesSql(" AND m.entity_id IN (?)")).bind(2).run();
    assert.equal(
      sqlite
        .prepare(
          "SELECT newest_in_stock_listed_at AS value FROM product_search_entities WHERE id=2",
        )
        .get()?.value,
      null,
    );
    const remaining = await searchProducts(db, productQuery("?inStock=true&sort=newest"));
    assert.deepEqual(
      remaining.items.map((row) => row.key),
      ["l-1"],
    );
  } finally {
    sqlite.close();
  }
});
