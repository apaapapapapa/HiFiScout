import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { upsertProducts } from "../src/db/product-write-repository.js";
import type { CatalogProductUpsertInput } from "../src/catalog/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const SHOP = "ippinkan";
const FIRST = "2026-08-25T00:00:00.000Z";
const SECOND = "2026-08-25T01:00:00.000Z";

function listing(
  sourceId: string,
  overrides: Partial<CatalogProductUpsertInput> = {},
): CatalogProductUpsertInput {
  return {
    sourceId,
    manufacturer: "DENON",
    model: `PMA-${sourceId}`,
    title: `DENON PMA-${sourceId}`,
    category: "プリメインアンプ",
    conditionText: "中古",
    priceYen: 100000,
    stockStatus: "in_stock",
    sourceUrl: `https://example.test/${sourceId}`,
    ...overrides,
  };
}

function emptyDatabase(): ReturnType<typeof migratedSqlite> {
  const database = migratedSqlite();
  database.sqlite.exec("DELETE FROM products;");
  return database;
}

test("a first crawl owes derived work for every listing it discovered", async () => {
  const { db } = emptyDatabase();
  const products = ["a", "b", "c"].map((id) => listing(id));

  const result = await upsertProducts(db, SHOP, products, FIRST);

  assert.equal(result.changedCount, 3);
  assert.deepEqual([...result.derivedSourceIds].sort(), ["a", "b", "c"]);
});

test("a routine crawl that changed nothing owes no derived work", async () => {
  const { db } = emptyDatabase();
  const products = ["a", "b", "c"].map((id) => listing(id));
  await upsertProducts(db, SHOP, products, FIRST);

  // The seller reports its whole inventory every time, but a listing nobody touched projects to
  // exactly what is already stored. Re-projecting all of it was the work that could not fit in one
  // invocation.
  const result = await upsertProducts(db, SHOP, products, SECOND);

  assert.equal(result.changedCount, 0);
  assert.deepEqual(result.derivedSourceIds, []);
});

test("only the listings whose inputs moved are handed to the derived stages", async () => {
  const { db } = emptyDatabase();
  const products = ["a", "b", "c"].map((id) => listing(id));
  await upsertProducts(db, SHOP, products, FIRST);

  const result = await upsertProducts(
    db,
    SHOP,
    [listing("a", { priceYen: 90000 }), listing("b"), listing("c"), listing("d")],
    SECOND,
  );

  assert.deepEqual([...result.derivedSourceIds].sort(), ["a", "d"]);
});

test("a listing that disappeared is named as derived work so its offer can be retired", async () => {
  const { sqlite, db } = emptyDatabase();
  await upsertProducts(
    db,
    SHOP,
    ["a", "b", "c"].map((id) => listing(id)),
    FIRST,
  );

  // A crawl reports what it saw, so a sold listing is never in the input. Without naming it here
  // nothing downstream would know to stop counting its offer.
  const result = await upsertProducts(db, SHOP, [listing("a"), listing("b")], SECOND, {
    deactivateMissing: true,
  });

  assert.equal(result.deactivatedCount, 1);
  assert.deepEqual(result.derivedSourceIds, ["c"]);
  const active = sqlite
    .prepare("SELECT is_active FROM products WHERE shop_key = ? AND source_id = ?")
    .get(SHOP, "c") as { is_active: number };
  assert.equal(active.is_active, 0);
});

test("a reactivated listing is derived work even when nothing else about it changed", async () => {
  const { db } = emptyDatabase();
  const products = ["a", "b"].map((id) => listing(id));
  await upsertProducts(db, SHOP, products, FIRST);
  await upsertProducts(db, SHOP, [listing("a")], SECOND, { deactivateMissing: true });

  const result = await upsertProducts(db, SHOP, products, "2026-08-25T02:00:00.000Z");

  assert.deepEqual(result.derivedSourceIds, ["b"]);
});
