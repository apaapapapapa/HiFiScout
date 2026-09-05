import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import {
  readListingProjectionTokens,
  acknowledgeListingProjections,
} from "../src/db/listing-projection-pending.js";

const AT = "2026-09-05T00:00:00.000Z";
const listing = (priceYen = 300000) =>
  normalizeCatalogProduct({
    sourceId: "one",
    manufacturer: "YAMAHA",
    model: "CD-S3000",
    title: "YAMAHA CD-S3000 CDプレーヤー",
    conditionText: "中古",
    priceYen,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/one",
  });

test("history failure rolls back the listing, dependent facts and projection obligation", async () => {
  const { db, sqlite } = migratedSqlite();
  sqlite.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON price_history BEGIN SELECT RAISE(ABORT,'injected history failure'); END;",
  );
  await assert.rejects(upsertProducts(db, "atomic", [listing()], AT), /injected history failure/);
  for (const table of [
    "products",
    "price_history",
    "product_categories",
    "listing_projection_pending",
  ]) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n, 0, table);
  }
  sqlite.exec("DROP TRIGGER fail_history");
  await upsertProducts(db, "atomic", [listing()], AT);
  const retry = await upsertProducts(db, "atomic", [listing()], AT);
  assert.equal(retry.changedCount, 0);
  assert.deepEqual(
    retry.derivedSourceIds,
    ["one"],
    "a committed listing still owes its interrupted continuation",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM price_history").get()?.n, 1);
  await refreshListingProjections(db, [{ shop_key: "atomic", source_id: "one" }], AT);
  assert.deepEqual((await upsertProducts(db, "atomic", [listing()], AT)).derivedSourceIds, []);
});

test("failed price change cannot publish a price whose observation was lost", async () => {
  const { db, sqlite } = migratedSqlite();
  await upsertProducts(db, "atomic", [listing()], AT);
  sqlite.exec(
    "CREATE TRIGGER fail_history BEFORE INSERT ON price_history BEGIN SELECT RAISE(ABORT,'injected'); END;",
  );
  await assert.rejects(
    upsertProducts(db, "atomic", [listing(200000)], "2026-09-05T01:00:00.000Z"),
    /injected/,
  );
  assert.equal(sqlite.prepare("SELECT price_yen FROM products").get()?.price_yen, 300000);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM price_history").get()?.n, 1);
  sqlite.exec("DROP TRIGGER fail_history");
  await upsertProducts(db, "atomic", [listing(200000)], "2026-09-05T01:00:00.000Z");
  await upsertProducts(db, "atomic", [listing(200000)], "2026-09-05T01:00:00.000Z");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM price_history").get()?.n, 2);
});

test("an old projection cannot clear a newer edit's obligation", async () => {
  const { db, sqlite } = migratedSqlite();
  await upsertProducts(db, "atomic", [listing()], AT);
  const old = await readListingProjectionTokens(db, "atomic", ["one"]);
  sqlite.exec("UPDATE products SET title = title || ' 修正' WHERE source_id = 'one'");
  await acknowledgeListingProjections(db, old);
  const current = await readListingProjectionTokens(db, "atomic", ["one"]);
  assert.equal(current.length, 1);
  assert.notEqual(current[0].token, old[0].token);
});

test("seller-category changes owe a projection even when the product type does not move", async () => {
  const { db, sqlite } = migratedSqlite();
  await upsertProducts(db, "atomic", [listing()], AT);
  await refreshListingProjections(db, [{ shop_key: "atomic", source_id: "one" }], AT);
  sqlite.exec("UPDATE products SET raw_category = 'studio CD player' WHERE source_id = 'one'");
  assert.equal((await readListingProjectionTokens(db, "atomic", ["one"])).length, 1);
});
