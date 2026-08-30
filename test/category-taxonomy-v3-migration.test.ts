import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { seedDataQualityRemediationQueue } from "../src/db/data-quality-remediation-queue-repository.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const V3_MIGRATION = "0068_category_taxonomy_v3.sql";
const AT = "2026-08-29T00:00:00.000Z";

interface LegacyProduct {
  id: number;
  sourceId: string;
  title: string;
  categoryId: string;
  directCategoryIds?: readonly string[];
}

function databaseBeforeV3(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (file === V3_MIGRATION) break;
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  return sqlite;
}

function migrateToV3(sqlite: DatabaseSync): void {
  sqlite.exec(readFileSync(new URL(V3_MIGRATION, MIGRATIONS), "utf8"));
}

function insertLegacyProduct(sqlite: DatabaseSync, product: LegacyProduct): void {
  const directCategoryIds = product.directCategoryIds ?? [product.categoryId];
  sqlite
    .prepare(`
      INSERT INTO products (
        id, shop_key, source_id, manufacturer, raw_manufacturer, manufacturer_id,
        canonical_manufacturer_id, manufacturer_resolution_status, model, raw_model,
        normalized_model, model_resolution_status, title, category, raw_category,
        primary_category_id, category_ids, direct_category_ids, classification_status,
        search_aliases, condition_text, price_yen, stock_status, source_url, first_seen_at,
        last_seen_at, last_changed_at, last_activity_at, is_active, metadata_json
      ) VALUES (
        ?, 'legacy-shop', ?, 'Example', 'Example', 'example', 'example', 'resolved', ?, ?, ?,
        'resolved', ?, ?, ?, ?, json_array(?), ?, 'classified', ?, 'used', 100000,
        'in_stock', ?, ?, ?, ?, ?, 1, '{}'
      )
    `)
    .run(
      product.id,
      product.sourceId,
      product.sourceId,
      product.sourceId,
      product.sourceId.toUpperCase(),
      product.title,
      product.categoryId,
      product.categoryId,
      product.categoryId,
      product.categoryId,
      JSON.stringify(directCategoryIds),
      product.categoryId,
      `https://example.test/${product.sourceId}`,
      AT,
      AT,
      AT,
      AT,
    );

  for (const categoryId of directCategoryIds) {
    sqlite
      .prepare(
        "INSERT INTO product_categories(product_id, category_id, is_direct) VALUES (?, ?, 1)",
      )
      .run(product.id, categoryId);
  }
}

function rows(sqlite: DatabaseSync, sql: string): Record<string, unknown>[] {
  return sqlite
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

test("taxonomy v3 migrates evidence and facets without splitting durable product identity", async () => {
  const sqlite = databaseBeforeV3();
  const legacyProducts: readonly LegacyProduct[] = [
    {
      id: 101,
      sourceId: "wireless-headphone",
      title: "Bluetooth Wireless Headphone H1",
      categoryId: "btw_headphone",
    },
    {
      id: 102,
      sourceId: "analog-xlr",
      title: "XLR Analog Interconnect Cable A1",
      categoryId: "cable_xlr",
    },
    {
      id: 103,
      sourceId: "digital-xlr",
      title: "AES/EBU XLR Digital Cable D1",
      categoryId: "cable_xlr",
    },
    {
      id: 104,
      sourceId: "disc-transport",
      title: "SACD Disc Transport P1",
      categoryId: "transport",
    },
    {
      id: 105,
      sourceId: "network-transport",
      title: "Network Transport N1",
      categoryId: "transport",
    },
    {
      id: 106,
      sourceId: "digital-bridge",
      title: "USB Digital Bridge U1",
      categoryId: "transport",
    },
    {
      id: 107,
      sourceId: "unknown-other",
      title: "Mystery Audio Widget Z9",
      categoryId: "other",
    },
    {
      id: 108,
      sourceId: "tuner-other",
      title: "FM Stereo Tuner T1",
      categoryId: "other",
    },
    {
      id: 109,
      sourceId: "disc-dac-set",
      title: "SACD Transport P1 + DAC D1",
      categoryId: "transport",
      directCategoryIds: ["transport", "dac"],
    },
  ];
  for (const product of legacyProducts) insertLegacyProduct(sqlite, product);

  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_products (
        id, manufacturer_id, canonical_model, normalized_model, canonical_name,
        verification_status, created_at, updated_at
      ) VALUES (701, 'example', 'P1', 'P1', 'Example Disc Transport P1', 'verified', ?, ?)
    `)
    .run(AT, AT);
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary)
      VALUES (701, 'cd_sacd_player', 1)
    `)
    .run();
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions (
        listing_product_id, catalog_product_id, status, match_method, confidence, evaluated_at
      ) VALUES (104, 701, 'matched', 'exact_model', 'high', ?)
    `)
    .run(AT);
  sqlite
    .prepare(
      "INSERT INTO price_history(id, product_id, price_yen, observed_at) VALUES (801, 104, 123456, ?)",
    )
    .run(AT);

  sqlite
    .prepare(`
      INSERT INTO product_admin_overrides (
        listing_product_id, primary_category_id, category_ids, category_name, search_aliases,
        created_at, updated_at
      ) VALUES (105, 'network_transport', '["network_transport"]', 'Network Transport',
                'network transport', ?, ?)
    `)
    .run(AT, AT);

  sqlite
    .prepare(`
      INSERT INTO product_search_entities (
        id, entity_key, entity_kind, catalog_product_id, primary_category_id,
        direct_category_ids, title_terms, category_terms
      ) VALUES (901, 'c-701', 'catalog', 701, 'cd_sacd_player', 'cd_sacd_player',
                'Example Disc Transport P1', 'cd_sacd_player')
    `)
    .run();
  sqlite
    .prepare(`
      INSERT INTO product_search_entities (
        id, entity_key, entity_kind, fallback_listing_id, primary_category_id,
        direct_category_ids, title_terms, category_terms
      ) VALUES (902, 'l-109', 'unresolved_listing', 109, 'transport', 'transport,dac',
                'SACD Transport P1 DAC D1', 'transport dac')
    `)
    .run();
  sqlite
    .prepare(
      "INSERT INTO product_search_entity_offers(listing_product_id, entity_id, shop_key) VALUES (104, 901, 'legacy-shop'), (109, 902, 'legacy-shop')",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO product_search_entity_categories(entity_id, category_id, is_direct) VALUES (901, 'cd_sacd_player', 1), (902, 'transport', 1), (902, 'dac', 1), (902, 'digital', 0)",
    )
    .run();

  const stableProducts = rows(
    sqlite,
    "SELECT id, shop_key, source_id, source_url, first_seen_at FROM products ORDER BY id",
  );
  const stableHistory = rows(sqlite, "SELECT * FROM price_history ORDER BY id");
  const stableIdentity = rows(
    sqlite,
    "SELECT listing_product_id, catalog_product_id, status, match_method, confidence, evaluated_at FROM product_identity_resolutions ORDER BY listing_product_id",
  );
  const stableSamples = rows(
    sqlite,
    "SELECT event_key, catalog_product_id, listing_product_id, source_price_history_id, price_yen, observed_at FROM knowledge_catalog_price_index_samples ORDER BY id",
  );
  const stableIndexes = rows(
    sqlite,
    "SELECT * FROM knowledge_catalog_price_indexes ORDER BY catalog_product_id",
  );
  const stableEntities = rows(
    sqlite,
    "SELECT id, entity_key, entity_kind, catalog_product_id, fallback_listing_id FROM product_search_entities ORDER BY id",
  );
  const stableOffers = rows(
    sqlite,
    "SELECT listing_product_id, entity_id, shop_key FROM product_search_entity_offers ORDER BY listing_product_id",
  );

  migrateToV3(sqlite);

  assert.deepEqual(
    rows(
      sqlite,
      "SELECT id, shop_key, source_id, source_url, first_seen_at FROM products ORDER BY id",
    ),
    stableProducts,
  );
  assert.deepEqual(rows(sqlite, "SELECT * FROM price_history ORDER BY id"), stableHistory);
  assert.deepEqual(
    rows(
      sqlite,
      "SELECT listing_product_id, catalog_product_id, status, match_method, confidence, evaluated_at FROM product_identity_resolutions ORDER BY listing_product_id",
    ),
    stableIdentity,
  );
  assert.deepEqual(
    rows(
      sqlite,
      "SELECT event_key, catalog_product_id, listing_product_id, source_price_history_id, price_yen, observed_at FROM knowledge_catalog_price_index_samples ORDER BY id",
    ),
    stableSamples,
  );
  assert.deepEqual(
    rows(sqlite, "SELECT * FROM knowledge_catalog_price_indexes ORDER BY catalog_product_id"),
    stableIndexes,
  );
  assert.deepEqual(
    rows(
      sqlite,
      "SELECT id, entity_key, entity_kind, catalog_product_id, fallback_listing_id FROM product_search_entities ORDER BY id",
    ),
    stableEntities,
  );
  assert.deepEqual(
    rows(
      sqlite,
      "SELECT listing_product_id, entity_id, shop_key FROM product_search_entity_offers ORDER BY listing_product_id",
    ),
    stableOffers,
  );

  assert.deepEqual(
    rows(
      sqlite,
      "SELECT id, primary_category_id, direct_category_ids, classification_status FROM products WHERE id BETWEEN 101 AND 109 ORDER BY id",
    ),
    [
      {
        id: 101,
        primary_category_id: "PER.HEADPHONE",
        direct_category_ids: '["PER.HEADPHONE"]',
        classification_status: "classified",
      },
      {
        id: 102,
        primary_category_id: "CAB.ANALOG",
        direct_category_ids: '["CAB.ANALOG"]',
        classification_status: "classified",
      },
      {
        id: 103,
        primary_category_id: "CAB.DIGITAL",
        direct_category_ids: '["CAB.DIGITAL"]',
        classification_status: "classified",
      },
      {
        id: 104,
        primary_category_id: "SRC.DISC",
        direct_category_ids: '["SRC.DISC"]',
        classification_status: "classified",
      },
      {
        id: 105,
        primary_category_id: "SRC.STREAMER",
        direct_category_ids: '["SRC.STREAMER"]',
        classification_status: "classified",
      },
      {
        id: 106,
        primary_category_id: "PRC.DDC",
        direct_category_ids: '["PRC.DDC"]',
        classification_status: "classified",
      },
      {
        id: 107,
        primary_category_id: "unclassified",
        direct_category_ids: '["unclassified"]',
        classification_status: "unclassified",
      },
      {
        id: 108,
        primary_category_id: "SRC.TUNER",
        direct_category_ids: '["SRC.TUNER"]',
        classification_status: "classified",
      },
      {
        id: 109,
        primary_category_id: "SRC.DISC",
        direct_category_ids: '["SRC.DISC","PRC.DAC"]',
        classification_status: "classified",
      },
    ],
  );

  const migratedVersions = rows(
    sqlite,
    `SELECT id,
            json_extract(metadata_json, '$.categoryClassification.version') AS version,
            json_extract(metadata_json, '$.categoryClassification.taxonomyVersion') AS taxonomy_version
     FROM products
     WHERE id BETWEEN 101 AND 109
     ORDER BY id`,
  );
  assert.equal(migratedVersions.length, 9);
  assert.ok(
    migratedVersions.every(
      (row) => Number(row.version) < RESOLUTION_VERSIONS.category && row.taxonomy_version === "v3",
    ),
    "SQL facet backfill must leave every migrated row eligible for complete bounded replay",
  );

  // Isolate category staleness from the earlier resolver stages, then execute the real automatic
  // selector. The migration must not merely *look* stale: every legacy row has to be seedable.
  sqlite
    .prepare(
      "UPDATE products SET manufacturer_resolver_version = ?, model_resolver_version = ? WHERE id BETWEEN 101 AND 109",
    )
    .run(RESOLUTION_VERSIONS.manufacturer, RESOLUTION_VERSIONS.model);
  sqlite
    .prepare(
      "UPDATE product_identity_resolutions SET identity_resolver_version = ? WHERE listing_product_id BETWEEN 101 AND 109",
    )
    .run(RESOLUTION_VERSIONS.identity);
  const replay = await seedDataQualityRemediationQueue(sqliteD1(sqlite), {
    limit: 20,
    now: "2026-08-30T00:00:00.000Z",
  });
  assert.equal(replay.selectedCount, 9);
  assert.ok(replay.workKeys.every((key) => key.startsWith("auto:classify_category:")));

  assert.deepEqual(
    rows(
      sqlite,
      "SELECT facet_id, facet_value FROM product_facet_facts WHERE product_id = 101 AND source = 'legacy_category' ORDER BY facet_id, facet_value",
    ),
    [
      { facet_id: "connectivity", facet_value: "wireless" },
      { facet_id: "protocol", facet_value: "bluetooth" },
    ],
  );
  assert.deepEqual(
    rows(
      sqlite,
      "SELECT product_id, facet_id, facet_value FROM product_facet_facts WHERE product_id IN (102, 103) AND source = 'legacy_category' AND facet_id IN ('connector_a', 'connector_b', 'signal_type') ORDER BY product_id, facet_id, facet_value",
    ),
    [
      { product_id: 102, facet_id: "connector_a", facet_value: "xlr" },
      { product_id: 102, facet_id: "connector_b", facet_value: "xlr" },
      { product_id: 102, facet_id: "signal_type", facet_value: "analog" },
      { product_id: 103, facet_id: "connector_a", facet_value: "xlr" },
      { product_id: 103, facet_id: "connector_b", facet_value: "xlr" },
      { product_id: 103, facet_id: "signal_type", facet_value: "digital" },
    ],
  );

  assert.deepEqual(
    rows(
      sqlite,
      "SELECT product_id, category_id, is_primary FROM knowledge_catalog_product_categories WHERE product_id = 701",
    ),
    [{ product_id: 701, category_id: "SRC.DISC", is_primary: 1 }],
  );
  assert.deepEqual(
    rows(
      sqlite,
      "SELECT listing_product_id, primary_category_id, category_ids FROM product_admin_overrides WHERE listing_product_id = 105",
    ),
    [
      {
        listing_product_id: 105,
        primary_category_id: "SRC.STREAMER",
        category_ids: '["SRC.STREAMER"]',
      },
    ],
  );
  assert.deepEqual(
    rows(
      sqlite,
      "SELECT entity_id, category_id, is_direct FROM product_search_entity_categories WHERE entity_id = 902 ORDER BY category_id",
    ),
    [
      { entity_id: 902, category_id: "PRC", is_direct: 0 },
      { entity_id: 902, category_id: "PRC.DAC", is_direct: 1 },
      { entity_id: 902, category_id: "SRC", is_direct: 0 },
      { entity_id: 902, category_id: "SRC.DISC", is_direct: 1 },
    ],
  );
  assert.deepEqual(
    rows(
      sqlite,
      "SELECT id, primary_category_id, direct_category_ids FROM product_search_entities WHERE id IN (901, 902) ORDER BY id",
    ),
    [
      { id: 901, primary_category_id: "SRC.DISC", direct_category_ids: "SRC.DISC" },
      { id: 902, primary_category_id: "SRC.DISC", direct_category_ids: "SRC.DISC,PRC.DAC" },
    ],
  );

  assert.deepEqual(
    rows(
      sqlite,
      "SELECT legacy_category_id, canonical_category_id, mapping_strategy, confidence FROM taxonomy_v3_migration_audit WHERE entity_type = 'product_primary' AND entity_id IN (102, 103, 107, 108) ORDER BY entity_id",
    ),
    [
      {
        legacy_category_id: "cable_xlr",
        canonical_category_id: "CAB.ANALOG",
        mapping_strategy: "evidence",
        confidence: 0.75,
      },
      {
        legacy_category_id: "cable_xlr",
        canonical_category_id: "CAB.DIGITAL",
        mapping_strategy: "evidence",
        confidence: 0.75,
      },
      {
        legacy_category_id: "other",
        canonical_category_id: "unclassified",
        mapping_strategy: "unclassified",
        confidence: 0,
      },
      {
        legacy_category_id: "other",
        canonical_category_id: "SRC.TUNER",
        mapping_strategy: "evidence",
        confidence: 0.75,
      },
    ],
  );
  const remainingOther = sqlite
    .prepare(`
          SELECT COUNT(*) AS count
          FROM products
          WHERE primary_category_id = 'other'
             OR category_ids LIKE '%"other"%'
             OR direct_category_ids LIKE '%"other"%'
        `)
    .get() as { count: number };
  assert.equal(Number(remainingOther.count), 0);
});
