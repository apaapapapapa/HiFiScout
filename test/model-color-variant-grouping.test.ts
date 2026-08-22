import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { resolveModel } from "../src/catalog/model-resolver.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const NOW = "2026-08-22T00:00:00.000Z";

function resolve(rawModel: string) {
  return resolveModel({ rawModel, manufacturerId: "tad" });
}

test("common color and finish presentations resolve to the same product model", () => {
  const variants = [
    "D-1000 ブラック",
    "D-1000 シルバー",
    "D-1000 BLACK",
    "D-1000 SILVER",
    "D-1000 カラー: ブラック",
    "D-1000 [BLACK]",
    "D-1000【シルバー】",
    "D-1000 / BK",
    "D-1000 - Black",
    "D-1000 ピアノブラック",
    "D-1000 Walnut",
  ];

  for (const rawModel of variants) {
    const result = resolve(rawModel);
    assert.equal(result.status, "resolved", rawModel);
    assert.equal(result.model, "D-1000", rawModel);
    assert.equal(result.normalizedModel, "D1000", rawModel);
    assert.ok(result.removedAnnotations.includes("presentation_color"), rawModel);
  }
});

test("color cleanup preserves real revision tokens and does not treat bare short suffixes as colors", () => {
  const revision = resolve("D-1000 MK2 ブラック");
  assert.equal(revision.model, "D-1000 MK2");
  assert.equal(revision.normalizedModel, "D1000MK2");

  const edition = resolve("E-800 SE シルバー");
  assert.equal(edition.model, "E-800 SE");
  assert.equal(edition.normalizedModel, "E800SE");

  const ambiguousShortSuffix = resolve("D-1000 S");
  assert.equal(ambiguousShortSuffix.model, "D-1000 S");
  assert.equal(ambiguousShortSuffix.normalizedModel, "D1000S");
});

function insertListing(
  sqlite: DatabaseSync,
  shopKey: string,
  sourceId: string,
  rawModel: string,
): number {
  const resolution = resolve(rawModel);
  assert.equal(resolution.status, "resolved");

  const result = sqlite
    .prepare(`
      INSERT INTO products(
        shop_key, source_id, manufacturer, model, title, category, condition_text,
        price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at,
        last_activity_at, is_active,
        raw_manufacturer, normalized_raw_manufacturer, manufacturer_id, canonical_manufacturer_id,
        manufacturer_resolution_status, raw_model, normalized_model, model_resolution_status,
        raw_category, primary_category_id, category_ids, classification_status, search_aliases
      ) VALUES (
        ?, ?, 'TAD', ?, ?, 'D/Aコンバーター', '中古',
        500000, 'in_stock', ?, ?, ?, ?,
        ?, 1,
        'TAD', 'TAD', 'tad', 'tad',
        'resolved', ?, ?, 'resolved',
        'D/Aコンバーター', 'dac', '["dac"]', 'classified', 'DAC D/A Converter'
      )
    `)
    .run(
      shopKey,
      sourceId,
      resolution.model,
      `TAD ${rawModel}`,
      `https://example.test/${shopKey}/${sourceId}`,
      NOW,
      NOW,
      NOW,
      NOW,
      rawModel,
      resolution.normalizedModel,
    );
  return Number(result.lastInsertRowid);
}

async function refreshBoth(db: QueryableDatabase): Promise<void> {
  await refreshListingProjections(
    db,
    [
      { shop_key: "black-shop", source_id: "black-1" },
      { shop_key: "silver-shop", source_id: "silver-1" },
    ],
    NOW,
  );
}

test("black and silver offers are projected into one product search area", async () => {
  const { sqlite, db } = migratedSqlite();
  const blackId = insertListing(sqlite, "black-shop", "black-1", "D-1000 ブラック");
  const silverId = insertListing(sqlite, "silver-shop", "silver-1", "D-1000 SILVER");

  await refreshBoth(db);

  const memberships = sqlite
    .prepare(`
      SELECT m.listing_product_id, e.entity_key, e.offer_count, e.shop_count
      FROM product_search_entity_offers m
      JOIN product_search_entities e ON e.id = m.entity_id
      WHERE m.listing_product_id IN (?, ?)
      ORDER BY m.listing_product_id
    `)
    .all(blackId, silverId) as Array<{
    listing_product_id: number;
    entity_key: string;
    offer_count: number;
    shop_count: number;
  }>;

  assert.equal(memberships.length, 2);
  assert.equal(memberships[0].entity_key, memberships[1].entity_key);
  assert.equal(memberships[0].offer_count, 2);
  assert.equal(memberships[0].shop_count, 2);
});
