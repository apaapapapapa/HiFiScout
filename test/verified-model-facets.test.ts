import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { verifiedModelFacetFacts } from "../src/catalog/verified-model-facets.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { parsedProduct } from "./helpers/fixtures.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { upsertProducts } from "../src/db/product-write-repository.js";

const facts = (model: string, overrides = {}) =>
  verifiedModelFacetFacts({
    manufacturerId: "bowers-wilkins",
    model,
    title: `B&W ${model}`,
    primaryCategoryId: "SPK.LOUDSPEAKER",
    ...overrides,
  });

test("reviewed speaker variants receive source-linked form facts without changing identities", () => {
  for (const model of [
    "805D3",
    "805D4/MR (ペア)",
    "805D4/B (ペア)",
    "805D4 MR (ペア)",
    "805S",
    "805S MR",
    "805 Diamond B",
    "805D3 (805Diamond ローズナット)",
    "805D4+FS805D4（ペア）",
    "805D4 SIGNATURE with Stand",
    "805 D4 Signature カリフォルニアバール・グロス",
  ]) {
    const actual = facts(model);
    assert.equal(actual.length, 1, model);
    assert.equal(actual[0].value, "bookshelf");
    assert.ok(actual[0].source.startsWith("verified_model:https://www.bowerswilkins.com/"));
  }
  const product = normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "B&W",
      model: "805D4/MR (ペア)",
      title: "B&W 805D4/MR (ペア)",
      rawCategory: "スピーカー",
    }),
  );
  assert.ok(product.facetFacts.some((f) => f.value === "bookshelf"));
  assert.equal(product.rawModel, "805D4/MR (ペア)");
});

test("unverified revisions, other brands, components and compatible stands acquire no form fact", () => {
  for (const model of [
    "FS805D3/B",
    "N805ST",
    "805D4SE",
    "805D4 Mk2",
    "1805D4",
    "805D4 + 802D4",
    "805D4用スタンド",
    "805D4 交換ユニット",
    "805 D4 Signature2",
  ])
    assert.deepEqual(facts(model), [], model);
  assert.deepEqual(facts("805D4", { manufacturerId: "other-brand" }), []);
  assert.deepEqual(facts("805D4", { primaryCategoryId: "ACC.STAND" }), []);
  assert.deepEqual(facts("805D4", { title: "B&W 805D4専用スタンド" }), []);
  for (const title of ["BW805D4+A12", "B&W 805D4 + A12", "B&W 805D4 + 802D4"])
    assert.deepEqual(facts("805D4", { title }), [], title);
  assert.deepEqual(facts("805D4+FS805D4", { title: "BW805D4+FS805D4+A12" }), []);
});

test("crawler replaces obsolete verified facets after model-only changes and preserves manual facts", async () => {
  const { sqlite, db } = migratedSqlite();
  const product = (model: string) =>
    normalizeCatalogProduct(
      parsedProduct({
        sourceId: "reviewed",
        sourceUrl: "https://example.test/reviewed",
        manufacturer: "B&W",
        model,
        title: "B&W 中古スピーカー",
        rawCategory: "スピーカー",
      }),
    );
  try {
    await upsertProducts(db, "shop", [product("805D4")], "2026-09-11T00:00:00.000Z");
    const listing = sqlite.prepare("SELECT id FROM products WHERE source_id='reviewed'").get() as {
      id: number;
    };
    const count = () =>
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) n FROM product_facet_facts WHERE product_id=? AND source LIKE 'verified_model:%'",
          )
          .get(listing.id) as { n: number }
      ).n;
    assert.equal(count(), 1);
    sqlite
      .prepare(
        "INSERT INTO product_facet_facts(product_id,facet_id,facet_value,source,confidence) VALUES (?,'use_case','home','manual',1)",
      )
      .run(listing.id);
    await upsertProducts(db, "shop", [product("805D4SE")], "2026-09-12T00:00:00.000Z");
    assert.equal(count(), 0);
    assert.equal(
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) n FROM product_facet_facts WHERE product_id=? AND source='manual'",
          )
          .get(listing.id) as { n: number }
      ).n,
      1,
    );
    await upsertProducts(db, "shop", [product("805D4")], "2026-09-13T00:00:00.000Z");
    assert.equal(count(), 1);
  } finally {
    sqlite.close();
  }
});
