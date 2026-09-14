import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { MODEL_RESOLVER_VERSION } from "../src/catalog/model-resolver.js";
import { CATEGORY_CLASSIFICATION_METADATA_VERSION } from "../src/catalog/product-normalizer.js";
import { splitKnownManufacturerModel } from "../src/catalog/manufacturers.js";
import { splitManufacturerModel } from "../src/crawler/normalize.js";
import { replayAdminCsvListings } from "../src/db/data-quality-remediation-service.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { insertListing } from "./helpers/listing-fixture.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";

const MIGRATION = "0127_taket_ws_catalog.sql";
const migration = readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
const AT = "2026-09-14T03:00:00.000Z";

test("TAKET-WS is not truncated when the model itself starts with the TakeT brand spelling", () => {
  assert.deepEqual(splitKnownManufacturerModel("TAKET-WS ( リスト・サウンド)"), {
    id: "taket",
    displayName: "TakeT",
    rawManufacturer: "TAKET",
    model: "TAKET-WS ( リスト・サウンド)",
  });
  assert.deepEqual(
    splitManufacturerModel("TAKET-WS ( リスト・サウンド)", "audiounion", "Take T"),
    {
      manufacturer: "Take T",
      model: "TAKET-WS ( リスト・サウンド)",
    },
  );
});

test("TakeT migration registers one verified official product idempotently", () => {
  const { sqlite } = migratedSqlite({ before: MIGRATION });
  try {
    sqlite.exec(migration);
    const product = sqlite
      .prepare(`SELECT id,manufacturer_id,canonical_model,normalized_model,canonical_name,
        lifecycle_status,verification_status,review_status
        FROM knowledge_catalog_products WHERE manufacturer_id='taket' AND normalized_model='TAKETWS'`)
      .get() as Record<string, unknown>;
    assert.deepEqual(
      {
        manufacturer_id: product.manufacturer_id,
        canonical_model: product.canonical_model,
        normalized_model: product.normalized_model,
        canonical_name: product.canonical_name,
        lifecycle_status: product.lifecycle_status,
        verification_status: product.verification_status,
        review_status: product.review_status,
      },
      {
        manufacturer_id: "taket",
        canonical_model: "TAKET-WS",
        normalized_model: "TAKETWS",
        canonical_name: "TakeT TAKET-WS",
        lifecycle_status: "active",
        verification_status: "verified",
        review_status: "current",
      },
    );
    assert.equal(
      sqlite
        .prepare(`SELECT category_id FROM knowledge_catalog_product_categories
          WHERE product_id=? AND is_primary=1`)
        .get(Number(product.id))?.category_id,
      "SPK.LOUDSPEAKER",
    );
    assert.equal(
      sqlite
        .prepare(`SELECT source_type FROM knowledge_catalog_sources
          WHERE product_id=? AND source_url='https://taket.jp/japanese/ws/ws.html'`)
        .get(Number(product.id))?.source_type,
      "manufacturer_official",
    );
    const changes = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changes);
  } finally {
    sqlite.close();
  }
});

test("AudioUnion TAKET-WS replay preserves evidence and converges every derived read model", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    const listingId = insertListing(sqlite, {
      at: AT,
      shop_key: "audiounion",
      source_id: "219551",
      source_url: "https://www.audiounion.jp/ct/detail/used/219551/",
      title: "Take T TAKET-WS ( リスト・サウンド)",
      manufacturer: "Take T",
      raw_manufacturer: "Take T",
      manufacturer_id: "taket",
      canonical_manufacturer_id: "",
      manufacturer_resolution_status: "unresolved",
      raw_model: "TAKET-WS ( リスト・サウンド)",
      model: "TAKET-WS ( リスト・サウンド)",
      normalized_model: "TAKETWS",
      model_resolution_status: "candidate",
      model_resolution_method: "unsafe_annotation",
      model_resolver_version: MODEL_RESOLVER_VERSION - 1,
      raw_category: "リスト・サウンド",
      category: "未分類",
      primary_category_id: "unclassified",
      category_ids: '["unclassified"]',
      direct_category_ids: '["unclassified"]',
      metadata_json: JSON.stringify({
        categoryClassification: { version: CATEGORY_CLASSIFICATION_METADATA_VERSION - 1 },
      }),
    });

    await replayAdminCsvListings(db, [listingId], AT);

    const listing = sqlite
      .prepare(`SELECT raw_manufacturer,manufacturer,canonical_manufacturer_id,raw_model,model,
        normalized_model,model_resolution_status,model_resolution_method,primary_category_id,
        direct_category_ids,remediation_projection_required
        FROM products WHERE id=?`)
      .get(listingId) as Record<string, unknown>;
    assert.deepEqual(
      { ...listing },
      {
        raw_manufacturer: "Take T",
        manufacturer: "TakeT",
        canonical_manufacturer_id: "taket",
        raw_model: "TAKET-WS ( リスト・サウンド)",
        model: "TAKET-WS",
        normalized_model: "TAKETWS",
        model_resolution_status: "resolved",
        model_resolution_method: "seller_model_annotated",
        primary_category_id: "SPK.LOUDSPEAKER",
        direct_category_ids: '["SPK.LOUDSPEAKER"]',
        remediation_projection_required: 0,
      },
    );
    const catalog = sqlite
      .prepare(`SELECT id FROM knowledge_catalog_products
        WHERE manufacturer_id='taket' AND normalized_model='TAKETWS'`)
      .get() as { id: number };
    assert.deepEqual(
      {
        ...sqlite
          .prepare(`SELECT status,match_method,catalog_product_id
            FROM product_identity_resolutions WHERE listing_product_id=?`)
          .get(listingId),
      },
      {
        status: "matched",
        match_method: "manufacturer_model_exact",
        catalog_product_id: catalog.id,
      },
    );
    const search = await searchProducts(db, productQuery("?q=TAKET-WS"));
    assert.equal(search.items[0]?.key, `c-${catalog.id}`);
    assert.equal(search.items[0]?.model, "TAKET-WS");
    assert.equal(search.items[0]?.category, "スピーカー");
  } finally {
    sqlite.close();
  }
});
