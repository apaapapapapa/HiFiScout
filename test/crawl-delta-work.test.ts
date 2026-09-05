import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { syncProductMetadata } from "../src/db/product-metadata-repository.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
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

async function completeInitialCrawl(
  db: ReturnType<typeof migratedSqlite>["db"],
  sourceIds: string[],
) {
  await refreshListingProjections(
    db,
    sourceIds.map((source_id) => ({ shop_key: SHOP, source_id })),
    FIRST,
  );
}

test("a first crawl owes derived work for every listing it discovered", async () => {
  const { db } = emptyDatabase();
  const products = ["a", "b", "c"].map((id) => listing(id));

  const result = await upsertProducts(db, SHOP, products, FIRST);
  await completeInitialCrawl(
    db,
    products.map((product) => product.sourceId),
  );

  assert.equal(result.changedCount, 3);
  assert.deepEqual([...result.derivedSourceIds].sort(), ["a", "b", "c"]);
});

test("a routine crawl that changed nothing owes no derived work", async () => {
  const { db } = emptyDatabase();
  const products = ["a", "b", "c"].map((id) => listing(id));
  await upsertProducts(db, SHOP, products, FIRST);
  await completeInitialCrawl(
    db,
    products.map((product) => product.sourceId),
  );

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
  await completeInitialCrawl(
    db,
    products.map((product) => product.sourceId),
  );

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
  await completeInitialCrawl(db, ["a", "b", "c"]);

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
  await completeInitialCrawl(
    db,
    products.map((product) => product.sourceId),
  );
  await upsertProducts(db, SHOP, [listing("a")], SECOND, { deactivateMissing: true });

  const result = await upsertProducts(db, SHOP, products, "2026-08-25T02:00:00.000Z");

  assert.deepEqual(result.derivedSourceIds, ["b"]);
});

function factRows(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]): Array<{
  source_id: string;
  feature_id: string;
  verified_at: string;
}> {
  return sqlite
    .prepare(`
      SELECT p.source_id AS source_id, f.feature_id AS feature_id, f.verified_at AS verified_at
      FROM product_feature_facts f
      JOIN products p ON p.id = f.product_id
      WHERE f.source = 'title'
      ORDER BY p.source_id, f.feature_id
    `)
    .all() as Array<{ source_id: string; feature_id: string; verified_at: string }>;
}

const PHONO = [
  {
    featureId: "phono_input" as const,
    state: "present" as const,
    source: "title",
    confidence: 0.8,
    verifiedAt: null,
  },
];

test("title feature facts are rewritten only for the listings whose title moved", async () => {
  const { sqlite, db } = emptyDatabase();
  const products = ["s-1", "s-2"].map((id) => listing(id, { featureFacts: PHONO }));

  const first = await upsertProducts(db, SHOP, products, FIRST);
  await completeInitialCrawl(
    db,
    products.map((product) => product.sourceId),
  );
  assert.equal(first.featureFactCount, 2);
  assert.equal(factRows(sqlite).length, 2);

  // The crawl used to repeat this delete-and-insert for the whole inventory on top of the delta
  // pass, rewriting every listing's facts to the values already stored.
  const unchanged = await upsertProducts(db, SHOP, products, SECOND);
  assert.equal(unchanged.featureFactCount, 0);
  assert.deepEqual(
    factRows(sqlite).map((row) => row.verified_at),
    [FIRST, FIRST],
    "an untouched listing keeps the facts it already had",
  );

  const moved = await upsertProducts(
    db,
    SHOP,
    [listing("s-1", { title: "DENON PMA-s-1 phono input", featureFacts: PHONO }), products[1]!],
    "2026-08-25T02:00:00.000Z",
  );
  assert.equal(moved.featureFactCount, 1, "only the listing whose title moved is rewritten");
});

test("a metadata-only change is invisible to the derived delta but still has to be stored", async () => {
  const { sqlite, db } = emptyDatabase();
  const products = [listing("v-1")];
  await upsertProducts(db, SHOP, products, FIRST);
  await completeInitialCrawl(
    db,
    products.map((product) => product.sourceId),
  );

  // The negative cache for detail-page fetches lives only here: it is written exactly when the
  // check did *not* classify, so every column `listingChanged` compares is left alone.
  const checked = [
    { ...products[0]!, metadata: { categoryClassification: { detailCheckedAt: SECOND } } },
  ];

  const result = await upsertProducts(db, SHOP, checked, SECOND);
  assert.deepEqual(
    result.derivedSourceIds,
    [],
    "the projection delta cannot see a change confined to metadata",
  );

  // Which is why the metadata pass is handed the whole observed set and compares the stored JSON
  // itself. Scoping it to the delta would drop the timestamp and re-fetch that seller page forever.
  const changed = await syncProductMetadata(db, SHOP, checked, SECOND);
  assert.equal(changed, 1);
  const stored = sqlite
    .prepare("SELECT metadata_json FROM products WHERE shop_key = ? AND source_id = ?")
    .get(SHOP, "v-1") as { metadata_json: string | null };
  assert.match(String(stored.metadata_json), /detailCheckedAt/u);
});
