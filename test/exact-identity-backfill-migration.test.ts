import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const MIGRATION_DIRECTORY = new URL("../migrations/", import.meta.url);

function databaseBeforeExactIdentityBackfill(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = readdirSync(MIGRATION_DIRECTORY)
    .filter((file) => file.endsWith(".sql") && file < "0036_group_exact_unresolved_product_offers.sql")
    .sort();
  for (const file of migrations) {
    sqlite.exec(readFileSync(new URL(file, MIGRATION_DIRECTORY), "utf8"));
  }
  return sqlite;
}

interface ListingFixture {
  shop: string;
  source: string;
  model: string;
  normalizedModel: string;
  category: string;
  price: number;
}

function insertListing(sqlite: DatabaseSync, fixture: ListingFixture): number {
  const result = sqlite
    .prepare(`
      INSERT INTO products(
        shop_key, source_id, manufacturer, model, title, category, condition_text,
        price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at,
        last_activity_at, is_active,
        raw_manufacturer, normalized_raw_manufacturer, manufacturer_id, canonical_manufacturer_id,
        manufacturer_resolution_status, raw_model, normalized_model, model_resolution_status,
        raw_category, primary_category_id, category_ids, classification_status
      ) VALUES (
        ?, ?, 'EDISCREATION', ?, ?, ?, '中古',
        ?, 'in_stock', ?, ?, ?, ?, ?, 1,
        'EDISCREATION', 'ediscreation', 'ediscreation', 'ediscreation',
        'resolved', ?, ?, 'resolved', ?, ?, ?, 'classified'
      )
    `)
    .run(
      fixture.shop,
      fixture.source,
      fixture.model,
      `EDISCREATION ${fixture.model}`,
      fixture.category,
      fixture.price,
      `https://example.test/${fixture.shop}/${fixture.source}`,
      "2026-08-20T00:00:00.000Z",
      "2026-08-22T00:00:00.000Z",
      "2026-08-21T00:00:00.000Z",
      "2026-08-21T00:00:00.000Z",
      fixture.model,
      fixture.normalizedModel,
      fixture.category,
      fixture.category,
      JSON.stringify([fixture.category]),
    );
  return Number(result.lastInsertRowid);
}

function createFallbackEntity(sqlite: DatabaseSync, listingId: number, fixture: ListingFixture): number {
  const result = sqlite
    .prepare(`
      INSERT INTO product_search_entities(
        entity_key, entity_kind, fallback_listing_id,
        manufacturer_id, manufacturer, model, normalized_model, primary_category_id,
        offer_count, in_stock_offer_count, shop_count, lowest_price_yen,
        lowest_in_stock_price_yen, highest_price_yen
      ) VALUES (
        ?, 'unresolved_listing', ?,
        'ediscreation', 'EDISCREATION', ?, ?, ?,
        1, 1, 1, ?, ?, ?
      )
    `)
    .run(
      `l-${listingId}`,
      listingId,
      fixture.model,
      fixture.normalizedModel,
      fixture.category,
      fixture.price,
      fixture.price,
      fixture.price,
    );
  const entityId = Number(result.lastInsertRowid);
  sqlite
    .prepare(
      "INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key) VALUES (?, ?, ?)",
    )
    .run(listingId, entityId, fixture.shop);
  return entityId;
}

function entityKeyForListing(sqlite: DatabaseSync, listingId: number): string {
  const row = sqlite
    .prepare(`
      SELECT e.entity_key
      FROM product_search_entity_offers membership
      JOIN product_search_entities e ON e.id = membership.entity_id
      WHERE membership.listing_product_id = ?
    `)
    .get(listingId) as { entity_key: string };
  return row.entity_key;
}

test("0036 groups only safe exact identities and prunes only affected fallback entities", () => {
  const sqlite = databaseBeforeExactIdentityBackfill();
  const fiberA: ListingFixture = {
    shop: "afroaudio",
    source: "fiber-a",
    model: "Fiber Box 2 JPSM",
    normalizedModel: "FIBERBOX2JPSM",
    category: "other",
    price: 140_000,
  };
  const fiberB: ListingFixture = {
    shop: "u-audio",
    source: "fiber-b",
    model: "Fiber Box 2 JPSM",
    normalizedModel: "FIBERBOX2JPSM",
    category: "other",
    price: 125_000,
  };
  const revision: ListingFixture = {
    shop: "fujiyacamera",
    source: "fiber-3",
    model: "Fiber Box 3 JPSM",
    normalizedModel: "FIBERBOX3JPSM",
    category: "other",
    price: 219_800,
  };
  const conflictA: ListingFixture = {
    shop: "shop-x",
    source: "conflict-a",
    model: "Shared 1",
    normalizedModel: "SHARED1",
    category: "dac",
    price: 100_000,
  };
  const conflictB: ListingFixture = {
    shop: "shop-y",
    source: "conflict-b",
    model: "Shared 1",
    normalizedModel: "SHARED1",
    category: "speaker",
    price: 110_000,
  };

  const fixtures = [fiberA, fiberB, revision, conflictA, conflictB];
  const listingIds = fixtures.map((fixture) => insertListing(sqlite, fixture));
  const originalEntityIds = listingIds.map((listingId, index) =>
    createFallbackEntity(sqlite, listingId, fixtures[index]!),
  );

  sqlite.exec(
    readFileSync(
      new URL("0036_group_exact_unresolved_product_offers.sql", MIGRATION_DIRECTORY),
      "utf8",
    ),
  );

  const fiberRepresentative = `l-${Math.min(listingIds[0]!, listingIds[1]!)}`;
  assert.equal(entityKeyForListing(sqlite, listingIds[0]!), fiberRepresentative);
  assert.equal(entityKeyForListing(sqlite, listingIds[1]!), fiberRepresentative);
  assert.equal(entityKeyForListing(sqlite, listingIds[2]!), `l-${listingIds[2]}`);
  assert.equal(entityKeyForListing(sqlite, listingIds[3]!), `l-${listingIds[3]}`);
  assert.equal(entityKeyForListing(sqlite, listingIds[4]!), `l-${listingIds[4]}`);

  const grouped = sqlite
    .prepare(`
      SELECT offer_count, shop_count, lowest_price_yen, highest_price_yen
      FROM product_search_entities
      WHERE entity_key = ?
    `)
    .get(fiberRepresentative) as Record<string, number>;
  assert.deepEqual(
    { ...grouped },
    { offer_count: 2, shop_count: 2, lowest_price_yen: 125_000, highest_price_yen: 140_000 },
  );

  const abandonedFiberEntityId =
    listingIds[0]! < listingIds[1]! ? originalEntityIds[1]! : originalEntityIds[0]!;
  assert.equal(
    sqlite.prepare("SELECT 1 FROM product_search_entities WHERE id = ?").get(abandonedFiberEntityId),
    undefined,
  );

  const helperTables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'migration_0036_%'")
    .all();
  assert.deepEqual(helperTables, []);
});

test("0036 materializes eligibility/grouping rather than correlated all-product scans", () => {
  const sql = readFileSync(
    new URL("0036_group_exact_unresolved_product_offers.sql", MIGRATION_DIRECTORY),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE migration_0036_eligible/u);
  assert.match(sql, /CREATE TABLE migration_0036_groups/u);
  assert.match(sql, /JOIN migration_0036_affected_entities/u);
  assert.doesNotMatch(sql, /SELECT MIN\(anchor\.id\)/u);
  assert.doesNotMatch(sql, /FROM products peer[\s\S]*peer\.canonical_manufacturer_id = p\./u);
});
