import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import type { CatalogNormalizationInput } from "../src/catalog/types.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";

const OBSERVED_AT = "2026-08-26T00:00:00.000Z";
const SHOP = "hifido";

/** A transport plus a DAC, which is the example the issue is written around. */
const SET_TITLE = "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC";

function listing(overrides: Partial<CatalogNormalizationInput> & { sourceId: string }) {
  return normalizeCatalogProduct({
    manufacturer: "",
    model: "",
    title: "",
    conditionText: "中古",
    priceYen: 1_000_000,
    stockStatus: "in_stock",
    sourceUrl: `https://example.test/${overrides.sourceId}`,
    ...overrides,
  });
}

async function seed(
  db: QueryableDatabase,
  products: readonly ReturnType<typeof listing>[],
): Promise<void> {
  await upsertProducts(db, SHOP, products, OBSERVED_AT);
  await refreshListingProjections(
    db,
    products.map((product) => ({ shop_key: SHOP, source_id: product.sourceId })),
    OBSERVED_AT,
  );
}

function facetCounts(sqlite: ReturnType<typeof migratedSqlite>["sqlite"]): Map<string, number> {
  const rows = sqlite
    .prepare(`
      SELECT ec.category_id AS value, COUNT(DISTINCT ec.entity_id) AS active_product_count
      FROM product_search_entity_categories ec
      GROUP BY ec.category_id
    `)
    .all() as unknown as { value: string; active_product_count: number }[];
  return new Map(rows.map((row) => [row.value, Number(row.active_product_count)]));
}

/** Acceptance case 1: both leaves and both v3 roots return the same one card. */
test("a set listing is found under either component category and either v3 root", async () => {
  const { sqlite, db } = migratedSqlite();
  await seed(db, [
    listing({ sourceId: "set-1", manufacturer: "ESOTERIC", model: SET_TITLE, title: SET_TITLE }),
  ]);

  for (const category of ["SRC.DISC", "PRC.DAC", "SRC", "PRC", "transport", "dac"]) {
    const found = await searchProducts(db, productQuery(`?category=${category}&includeTotal=true`));
    assert.equal(found.totalCount, 1, `?category=${category} must return the set listing`);
    assert.equal(found.items.length, 1);
  }
  assert.ok(sqlite);
});

/** Acceptance case 8: the count and the filtered result are the same number. */
test("every category facet count equals the cards that category filter returns", async () => {
  const { sqlite, db } = migratedSqlite();
  await seed(db, [
    listing({ sourceId: "set-1", manufacturer: "ESOTERIC", model: SET_TITLE, title: SET_TITLE }),
    listing({
      sourceId: "single-1",
      manufacturer: "Marantz",
      model: "PM-14S1",
      title: "Marantz PM-14S1 プリメインアンプ",
    }),
    listing({
      sourceId: "single-2",
      manufacturer: "ESOTERIC",
      model: "K-01XD",
      title: "ESOTERIC K-01XD SACDプレーヤー",
    }),
  ]);

  const counts = facetCounts(sqlite);
  assert.ok(counts.size > 0, "the fixture must produce facets to compare against");
  for (const [category, count] of counts) {
    const found = await searchProducts(db, productQuery(`?category=${category}&includeTotal=true`));
    assert.equal(found.totalCount, count, `facet ${category} claims ${count}`);
  }
});

/** The set contributes one card to each product type and root. */
test("a set contributes one card to each v3 category membership", async () => {
  const { sqlite, db } = migratedSqlite();
  await seed(db, [
    listing({ sourceId: "set-1", manufacturer: "ESOTERIC", model: SET_TITLE, title: SET_TITLE }),
  ]);

  const counts = facetCounts(sqlite);
  assert.equal(counts.get("SRC"), 1);
  assert.equal(counts.get("SRC.DISC"), 1);
  assert.equal(counts.get("PRC"), 1);
  assert.equal(counts.get("PRC.DAC"), 1);
});

/** Acceptance case 7: a single product behaves exactly as it always has. */
test("a single-product listing is found under its category and its parent only", async () => {
  const { db } = migratedSqlite();
  await seed(db, [
    listing({
      sourceId: "single-1",
      manufacturer: "Marantz",
      model: "PM-14S1",
      title: "Marantz PM-14S1 プリメインアンプ",
    }),
  ]);

  for (const category of ["AMP.INTEGRATED", "AMP", "integrated_amp", "amplifier"]) {
    const found = await searchProducts(db, productQuery(`?category=${category}&includeTotal=true`));
    assert.equal(found.totalCount, 1, `?category=${category} must return the listing`);
  }
  for (const category of ["PRC.DAC", "PRC", "SRC.DISC", "SRC"]) {
    const found = await searchProducts(db, productQuery(`?category=${category}&includeTotal=true`));
    assert.equal(found.totalCount, 0, `?category=${category} must not return an amplifier`);
  }
});

/** Membership is projected from active offers, so a sold-out listing stops being filterable. */
test("a listing that goes inactive leaves the categories it was found under", async () => {
  const { sqlite, db } = migratedSqlite();
  const set = listing({
    sourceId: "set-1",
    manufacturer: "ESOTERIC",
    model: SET_TITLE,
    title: SET_TITLE,
  });
  await seed(db, [set]);
  assert.equal((await searchProducts(db, productQuery("?category=PRC.DAC"))).items.length, 1);

  await upsertProducts(db, SHOP, [], "2026-08-27T00:00:00.000Z", { deactivateMissing: true });
  await refreshListingProjections(
    db,
    [{ shop_key: SHOP, source_id: "set-1" }],
    "2026-08-27T00:00:00.000Z",
  );

  assert.equal((await searchProducts(db, productQuery("?category=PRC.DAC"))).items.length, 0);
  assert.equal((await searchProducts(db, productQuery("?category=SRC.DISC"))).items.length, 0);
  // The facet counts this projection on its own, with no join back to the entity, so a row left
  // behind by a pruned entity would be a category claiming a card that no longer exists.
  assert.equal(facetCounts(sqlite).size, 0, "membership must not outlive the entity it names");
});

/**
 * Acceptance case 6. The identity model of a set is the concatenation of its components, so it
 * cannot equal one catalog product's — which means the safety is currently a consequence of how
 * the resolver happens to spell a set, not a rule. This pins it: if an annotation rule ever
 * strips one half, a two-product sale would silently become offers of one product.
 */
test("a set is not absorbed into the catalog entity of one of its components", async () => {
  const { sqlite, db } = migratedSqlite();
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_products(
        manufacturer_id, canonical_model, normalized_model, canonical_name,
        verification_status, created_at, updated_at
      ) VALUES ('esoteric', 'Grandioso P1', 'GRANDIOSOP1', 'ESOTERIC Grandioso P1',
                'verified', ?, ?)
    `)
    .run(OBSERVED_AT, OBSERVED_AT);

  await seed(db, [
    listing({
      sourceId: "single-p1",
      manufacturer: "ESOTERIC",
      model: "Grandioso P1",
      title: "ESOTERIC Grandioso P1 SACDトランスポート",
    }),
    listing({ sourceId: "set-1", manufacturer: "ESOTERIC", model: SET_TITLE, title: SET_TITLE }),
  ]);

  const kinds = sqlite
    .prepare(`
      SELECT p.source_id AS source_id, e.entity_kind AS entity_kind
      FROM products p
      JOIN product_search_entity_offers m ON m.listing_product_id = p.id
      JOIN product_search_entities e ON e.id = m.entity_id
      ORDER BY p.source_id
    `)
    .all() as unknown as { source_id: string; entity_kind: string }[];

  const set = kinds.find((row) => row.source_id === "set-1");
  assert.equal(
    set?.entity_kind,
    "unresolved_listing",
    "a set stays a listing-level entity while identity can hold only one product",
  );
  assert.equal(
    new Set(kinds.map((row) => row.entity_kind)).size <= 2,
    true,
    "the fixture must produce both a catalog and a fallback entity to be meaningful",
  );

  // And the two are separate cards rather than two offers of the transport.
  const transport = await searchProducts(db, productQuery("?category=transport&includeTotal=true"));
  assert.equal(transport.totalCount, 2);
  for (const item of transport.items) assert.equal(item.offer_count, 1);
});
