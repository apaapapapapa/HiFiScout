import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  AUDIOUNION_LEGACY_DETAIL_PREFIX as LEGACY,
  MAX_RETIRED_LISTINGS,
  retireAudioUnionLegacyListings,
} from "../scripts/retire-audiounion-legacy-listings.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const AT = "2026-10-01T00:00:00.000Z";
const RETIRED_AT = "2026-10-29T00:00:00.000Z";

function seed(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]) {
  const insert = sqlite.prepare(`INSERT INTO products(shop_key,source_id,title,source_url,
    first_seen_at,last_seen_at,last_changed_at,stock_status,is_active) VALUES (?,?,?,?,?,?,?,?,?)`);
  const rows: [string, string, string, string, number][] = [
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
  ];
  // More legacy rows than one bounded statement retires, across every stored state.
  for (let id = 1; id <= 250; id += 1)
    rows.push([
      "audiounion",
      `${1000 + id}`,
      `${LEGACY}${1000 + id}/`,
      ["in_stock", "sold_out", "unknown"][id % 3],
      1,
    ]);
  for (const [shop, id, url, stock, active] of rows)
    insert.run(shop, id, `LUXMAN L-${id}`, url, AT, AT, AT, stock, active);
  sqlite.exec("DELETE FROM listing_projection_pending");
}

test("retired AudioUnion legacy routes end in bounded batches without becoming sale evidence", async () => {
  const { sqlite, db } = migratedSqlite();
  const log = console.log;
  console.log = () => {};
  try {
    seed(sqlite);
    assert.equal(await retireAudioUnionLegacyListings(db, RETIRED_AT), 250);
    const states = sqlite
      .prepare(
        `SELECT source_id, stock_status, is_active, last_changed_at FROM products
        WHERE source_id IN ('1001','1002','1003','4','goods:22U9059782635','26-50529-16848-00')
        ORDER BY id`,
      )
      .all()
      .map((row) => Object.values(row));
    assert.deepEqual(states, [
      ["4", "in_stock", 0, AT],
      ["goods:22U9059782635", "in_stock", 1, AT],
      ["26-50529-16848-00", "in_stock", 1, AT],
      ["1001", "sold_out", 0, RETIRED_AT],
      ["1002", "unknown", 0, RETIRED_AT],
      ["1003", "unknown", 0, RETIRED_AT],
    ]);
    // Derived listing projections and public counts follow through the existing triggers.
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM listing_projection_pending").get()?.n,
      250,
    );
    assert.equal(
      sqlite
        .prepare("SELECT row_count FROM public_meta_counts WHERE kind = 'shop' AND value = ?")
        .get("audiounion")?.row_count,
      1,
    );
    // A repeated run finds nothing left and changes nothing.
    const before = sqlite.prepare("SELECT * FROM products ORDER BY id").all();
    assert.equal(await retireAudioUnionLegacyListings(db, "2026-10-30T00:00:00.000Z"), 0);
    assert.deepEqual(sqlite.prepare("SELECT * FROM products ORDER BY id").all(), before);
  } finally {
    console.log = log;
    sqlite.close();
  }
});

test("an unexpectedly large legacy scope stops before writing anything", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i <= ${MAX_RETIRED_LISTINGS})
      INSERT INTO products(shop_key,source_id,title,source_url,first_seen_at,last_seen_at,
        last_changed_at,stock_status,is_active)
      SELECT 'audiounion', i, 'Amp', '${LEGACY}' || i || '/', '${AT}', '${AT}', '${AT}', 'in_stock', 1 FROM n`);
    await assert.rejects(
      retireAudioUnionLegacyListings(db, RETIRED_AT),
      /audiounion_legacy_retirement_unexpected_scope/u,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM products WHERE is_active = 1").get()?.n,
      MAX_RETIRED_LISTINGS + 1,
    );
  } finally {
    sqlite.close();
  }
});
