import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";

const NAME = "0144_retire_audiounion_legacy_listings.sql";
const AT = "2026-10-01T00:00:00.000Z";
const LEGACY = "https://www.audiounion.jp/ct/detail/used/";

test("retired AudioUnion legacy routes end without becoming sale evidence", () => {
  const { sqlite } = migratedSqlite({ before: NAME });
  try {
    const insert = sqlite.prepare(`INSERT INTO products(shop_key,source_id,title,source_url,
      first_seen_at,last_seen_at,last_changed_at,stock_status,is_active) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const [shop, id, url, stock, active] of [
      ["audiounion", "1", `${LEGACY}1/`, "in_stock", 1],
      ["audiounion", "2", `${LEGACY}2/`, "sold_out", 1],
      ["audiounion", "3", `${LEGACY}3/`, "unknown", 1],
      ["audiounion", "4", `${LEGACY}4/`, "in_stock", 0],
      [
        "audiounion",
        "goods:22U9059782635",
        "https://www.audiounion.jp/shop/g/g22U9059782635/",
        "in_stock",
        1,
      ],
      [
        "hifido",
        "26-50529-16848-00",
        "https://www.hifido.co.jp/26-50529-16848-00.html",
        "in_stock",
        1,
      ],
    ] as const)
      insert.run(shop, id, `LUXMAN L-50${id}`, url, AT, AT, AT, stock, active);
    sqlite.exec("DELETE FROM listing_projection_pending");
    const migration = migrationSources.find((source) => source.name === NAME);
    assert.ok(migration);

    sqlite.exec(migration.sql);
    const rows = () =>
      sqlite
        .prepare(
          "SELECT source_id, stock_status, is_active, last_changed_at FROM products ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row }));
    const retired = rows();
    assert.deepEqual(
      retired.map(({ source_id, stock_status, is_active }) => [source_id, stock_status, is_active]),
      [
        ["1", "unknown", 0],
        ["2", "sold_out", 0],
        ["3", "unknown", 0],
        ["4", "in_stock", 0],
        ["goods:22U9059782635", "in_stock", 1],
        ["26-50529-16848-00", "in_stock", 1],
      ],
    );
    for (const row of retired.slice(0, 3))
      assert.match(String(row.last_changed_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
    for (const row of retired.slice(3)) assert.equal(row.last_changed_at, AT);
    // Derived listing projections and public counts follow through the existing triggers.
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT p.source_id FROM listing_projection_pending q JOIN products p ON p.id = q.listing_product_id ORDER BY p.id",
        )
        .all()
        .map((row) => row.source_id),
      ["1", "2", "3"],
    );
    assert.equal(
      sqlite
        .prepare("SELECT row_count FROM public_meta_counts WHERE kind = 'shop' AND value = ?")
        .get("audiounion")?.row_count,
      1,
    );

    // A repeated application finds nothing left to retire.
    sqlite.exec(migration.sql);
    assert.deepEqual(rows(), retired);
  } finally {
    sqlite.close();
  }
});
