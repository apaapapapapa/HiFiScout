import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { VerifiedKnowledgeSource } from "../src/catalog/knowledge-verification/types.js";
import { normalizeCatalogModel } from "../src/catalog/knowledge-catalog.js";
import { manufacturerIdForFilter } from "../src/catalog/manufacturers.js";
import { normalizeIdentityModel } from "../src/catalog/product-identity.js";
import { createKnowledgeCatalogAdminProduct } from "../src/db/knowledge-catalog-admin-operations.js";
import { convergeKnowledgeCatalogIdentityDuplicates } from "../src/db/knowledge-catalog-identity-dedup.js";
import { findCatalogProductByIdentity } from "../src/db/knowledge-catalog-identity.js";
import { promoteVerifiedKnowledgeCatalogCandidate } from "../src/db/knowledge-catalog-verification-repository.js";
import type { PendingKnowledgeCatalogCandidate, QueryableDatabase } from "../src/db/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const NOW = "2026-02-01T00:00:00.000Z";
const CATEGORY = "AMP.INTEGRATED";

type Sqlite = ReturnType<typeof migratedSqlite>["sqlite"];

/**
 * Two spellings of one model. The catalog normalizer keeps the separator, so each is a distinct
 * value of `UNIQUE(manufacturer_id, normalized_model)`; the identity normalizer drops it, so
 * Product Identity considers them one product. That gap is what used to split a product across two
 * Catalog rows, and the fixture asserts it rather than assuming it.
 */
const SPACED_MODEL = "MODEL-100";
const TIGHT_MODEL = "MODEL100";
const MANUFACTURER = "luxman";

test("the fixture models really do differ in storage and agree in identity", () => {
  assert.notEqual(normalizeCatalogModel(SPACED_MODEL), normalizeCatalogModel(TIGHT_MODEL));
  assert.equal(normalizeIdentityModel(SPACED_MODEL), normalizeIdentityModel(TIGHT_MODEL));
});

/** Migrations seed real catalog rows, so every case starts from an empty catalog. */
function emptyCatalog(): ReturnType<typeof migratedSqlite> {
  const database = migratedSqlite();
  database.sqlite.exec(`
    DELETE FROM product_search_entity_offers;
    DELETE FROM product_search_entities;
    DELETE FROM knowledge_catalog_price_index_samples;
    DELETE FROM product_identity_resolutions;
    DELETE FROM knowledge_catalog_verification_attempts;
    DELETE FROM knowledge_catalog_candidates;
    DELETE FROM knowledge_catalog_products;
    DELETE FROM price_history;
    DELETE FROM products;
  `);
  return database;
}

function candidateFor(model: string, id: number): PendingKnowledgeCatalogCandidate {
  return {
    id,
    manufacturerId: MANUFACTURER,
    normalizedModel: normalizeCatalogModel(model),
    observedManufacturer: "Luxman",
    observedModel: model,
    sampleTitle: `Luxman ${model}`,
    priorityScore: 100,
    verificationStatus: "unverified",
    lastVerificationAt: null,
  };
}

function verificationFor(model: string): VerifiedKnowledgeSource {
  return {
    status: "verified",
    sourceUrl: `https://example.test/${model.toLowerCase()}`,
    sourceType: "manufacturer_official",
    httpStatus: 200,
    canonicalModel: model,
    canonicalName: `Luxman ${model}`,
    categoryIds: [CATEGORY],
    primaryCategoryId: CATEGORY,
    contentHash: "b".repeat(64),
    message: "verified",
  };
}

/** Upserts, so re-running one promotion reuses the candidate the first run already matched. */
function insertCandidate(sqlite: Sqlite, model: string): number {
  sqlite
    .prepare(`
        INSERT INTO knowledge_catalog_candidates (
          manufacturer_id, normalized_model, observed_manufacturer, observed_model, sample_title,
          candidate_category_ids, review_status, last_reviewed_at, created_at, updated_at
        ) VALUES (?, ?, 'Luxman', ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(manufacturer_id, normalized_model) DO UPDATE SET updated_at = excluded.updated_at
      `)
    .run(
      MANUFACTURER,
      normalizeCatalogModel(model),
      model,
      `Luxman ${model}`,
      JSON.stringify([CATEGORY]),
      NOW,
      NOW,
      NOW,
    );
  return Number(
    (
      sqlite
        .prepare(
          "SELECT id FROM knowledge_catalog_candidates WHERE manufacturer_id = ? AND normalized_model = ?",
        )
        .get(MANUFACTURER, normalizeCatalogModel(model)) as { id: number }
    ).id,
  );
}

/** Promote a candidate for `model`, creating the candidate row the promotion updates. */
async function promote(database: ReturnType<typeof migratedSqlite>, model: string) {
  const candidateId = insertCandidate(database.sqlite, model);
  return promoteVerifiedKnowledgeCatalogCandidate(
    database.db,
    candidateFor(model, candidateId),
    verificationFor(model),
    NOW,
  );
}

function insertCatalogProduct(sqlite: Sqlite, model: string, firstVerifiedAt = NOW): number {
  const productId = Number(
    sqlite
      .prepare(`
        INSERT INTO knowledge_catalog_products (
          manufacturer_id, canonical_model, normalized_model, canonical_name, lifecycle_status,
          verification_status, review_status, first_verified_at, last_verified_at,
          last_remediated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'unknown', 'verified', 'current', ?, ?, ?, ?, ?)
      `)
      .run(
        MANUFACTURER,
        model,
        normalizeCatalogModel(model),
        `Luxman ${model}`,
        firstVerifiedAt,
        NOW,
        NOW,
        NOW,
        NOW,
      ).lastInsertRowid,
  );
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_product_categories (product_id, category_id, is_primary)
      VALUES (?, ?, 1)
    `)
    .run(productId, CATEGORY);
  return productId;
}

let nextListing = 0;

/** A matched listing carrying a price observation, so the price-index triggers produce a sample. */
function insertMatchedListing(sqlite: Sqlite, catalogProductId: number, model: string): number {
  nextListing += 1;
  const sourceId = `listing-${nextListing}`;
  const listingId = Number(
    sqlite
      .prepare(`
        INSERT INTO products (
          shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
          is_active, price_yen, manufacturer, raw_manufacturer, manufacturer_id,
          canonical_manufacturer_id, manufacturer_resolution_status, model, raw_model,
          normalized_model, model_resolution_status, primary_category_id, category_ids,
          classification_status
        ) VALUES ('shop', ?, ?, ?, ?, ?, ?, 1, 1000, 'Luxman', 'Luxman', ?, ?, 'resolved', ?, ?, ?,
                  'resolved', ?, ?, 'classified')
      `)
      .run(
        sourceId,
        `Luxman ${model}`,
        `https://example.test/${sourceId}`,
        NOW,
        NOW,
        NOW,
        manufacturerIdForFilter(MANUFACTURER),
        manufacturerIdForFilter(MANUFACTURER),
        model,
        model,
        normalizeIdentityModel(model),
        CATEGORY,
        JSON.stringify([CATEGORY]),
      ).lastInsertRowid,
  );
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions (
        listing_product_id, catalog_product_id, status, match_method, confidence, evaluated_at
      ) VALUES (?, ?, 'matched', 'test', 'high', ?)
    `)
    .run(listingId, catalogProductId, NOW);
  sqlite
    .prepare("INSERT INTO price_history (product_id, price_yen, observed_at) VALUES (?, 1000, ?)")
    .run(listingId, NOW);
  return listingId;
}

function catalogProductIds(sqlite: Sqlite): number[] {
  return (
    sqlite.prepare("SELECT id FROM knowledge_catalog_products ORDER BY id").all() as {
      id: number;
    }[]
  ).map((row) => Number(row.id));
}

function count(sqlite: Sqlite, sql: string, ...binds: unknown[]): number {
  return Number(
    (sqlite.prepare(sql).get(...(binds as never[])) as { total: number } | undefined)?.total || 0,
  );
}

function priceIndexRows(sqlite: Sqlite): { catalog_product_id: number; count: number }[] {
  return sqlite
    .prepare(`
      SELECT catalog_product_id, COUNT(*) AS count
      FROM knowledge_catalog_price_indexes
      GROUP BY catalog_product_id
    `)
    .all() as { catalog_product_id: number; count: number }[];
}

async function converge(db: QueryableDatabase) {
  return convergeKnowledgeCatalogIdentityDuplicates(db, { mergedAt: NOW });
}

test("promotion converges spellings that differ only outside the identity model", async () => {
  const database = emptyCatalog();

  const first = await promote(database, SPACED_MODEL);
  const second = await promote(database, TIGHT_MODEL);

  assert.equal(first.promoted, true);
  assert.equal(second.promoted, false);
  assert.equal(second.reason, "already_exists");
  assert.equal(second.productId, first.productId);
  assert.deepEqual(catalogProductIds(database.sqlite), [first.productId]);
});

test("promotion converges a spelling stored under a legacy manufacturer id", async () => {
  const database = emptyCatalog();
  const canonical = Number(
    database.sqlite
      .prepare(`
        INSERT INTO knowledge_catalog_products (
          manufacturer_id, canonical_model, normalized_model, canonical_name, lifecycle_status,
          verification_status, review_status, first_verified_at, last_verified_at, created_at,
          updated_at
        ) VALUES ('bw', '805 D4', '805 D4', 'Bowers & Wilkins 805 D4', 'unknown', 'verified',
                  'current', ?, ?, ?, ?)
      `)
      .run(NOW, NOW, NOW, NOW).lastInsertRowid,
  );

  const existing = await findCatalogProductByIdentity(database.db, "bowers-wilkins", "805D4");

  assert.equal(existing?.id, canonical);
});

test("repeating one promotion never adds a second catalog product", async () => {
  const database = emptyCatalog();

  const first = await promote(database, SPACED_MODEL);
  const repeat = await promote(database, SPACED_MODEL);

  assert.equal(repeat.productId, first.productId);
  assert.deepEqual(catalogProductIds(database.sqlite), [first.productId]);
});

test("a manual admin write lands on the catalog record the identity already names", async () => {
  const database = emptyCatalog();
  const existing = await promote(database, SPACED_MODEL);

  await assert.rejects(
    createKnowledgeCatalogAdminProduct(
      database.db,
      {
        manufacturerId: MANUFACTURER,
        canonicalModel: TIGHT_MODEL,
        canonicalName: `Luxman ${TIGHT_MODEL}`,
        lifecycleStatus: "unknown",
        primaryCategoryId: CATEGORY,
        sourceUrl: "https://example.test/manual",
      },
      NOW,
    ),
    new RegExp(`catalog_admin_product_already_exists:${existing.productId}`, "u"),
  );
  assert.deepEqual(catalogProductIds(database.sqlite), [existing.productId]);
});

test("convergence collapses existing logical duplicates onto one deterministic survivor", async () => {
  const database = emptyCatalog();
  const busy = insertCatalogProduct(database.sqlite, SPACED_MODEL, "2026-01-02T00:00:00.000Z");
  const quiet = insertCatalogProduct(database.sqlite, TIGHT_MODEL, "2026-01-01T00:00:00.000Z");
  const busyListing = insertMatchedListing(database.sqlite, busy, SPACED_MODEL);
  insertMatchedListing(database.sqlite, busy, SPACED_MODEL);
  const quietListing = insertMatchedListing(database.sqlite, quiet, TIGHT_MODEL);
  database.sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_aliases (product_id, alias, normalized_alias, alias_type, created_at)
      VALUES (?, ?, ?, 'model', ?)
    `)
    .run(quiet, "MODEL 100", normalizeCatalogModel("MODEL 100"), NOW);

  const result = await converge(database.db);

  assert.deepEqual(
    { ...result },
    { convergedGroups: 1, removedProducts: 1, incompleteGroups: 0, hasMore: false },
  );
  assert.deepEqual(catalogProductIds(database.sqlite), [busy]);
  assert.equal(
    count(
      database.sqlite,
      "SELECT COUNT(*) AS total FROM product_identity_resolutions WHERE catalog_product_id = ?",
      busy,
    ),
    3,
    "every matched listing follows the survivor",
  );
  for (const listing of [busyListing, quietListing]) {
    assert.equal(
      count(
        database.sqlite,
        "SELECT COUNT(*) AS total FROM product_identity_resolutions WHERE listing_product_id = ? AND catalog_product_id = ?",
        listing,
        busy,
      ),
      1,
    );
  }
  assert.equal(
    count(
      database.sqlite,
      "SELECT COUNT(*) AS total FROM knowledge_catalog_aliases WHERE product_id = ? AND normalized_alias = ?",
      busy,
      normalizeCatalogModel("MODEL 100"),
    ),
    1,
    "an alias only the duplicate carried keeps resolving to the survivor",
  );
  assert.equal(
    count(
      database.sqlite,
      "SELECT COUNT(*) AS total FROM knowledge_catalog_aliases WHERE product_id = ? AND normalized_alias = ?",
      busy,
      normalizeCatalogModel(TIGHT_MODEL),
    ),
    1,
    "the duplicate's own model becomes an alias of the survivor",
  );
  assert.equal(
    count(
      database.sqlite,
      "SELECT COUNT(*) AS total FROM knowledge_catalog_products WHERE last_remediated_at IS NULL AND id = ?",
      busy,
    ),
    1,
    "the survivor is owed the replay that re-resolves its new listings",
  );
});

test("convergence leaves one price index row per surviving catalog product", async () => {
  const database = emptyCatalog();
  const busy = insertCatalogProduct(database.sqlite, SPACED_MODEL, "2026-01-02T00:00:00.000Z");
  const quiet = insertCatalogProduct(database.sqlite, TIGHT_MODEL, "2026-01-01T00:00:00.000Z");
  insertMatchedListing(database.sqlite, busy, SPACED_MODEL);
  insertMatchedListing(database.sqlite, busy, SPACED_MODEL);
  insertMatchedListing(database.sqlite, quiet, TIGHT_MODEL);
  // Retention-safe evidence: the listing it came from is gone, so no identity resolution can carry
  // it across. It must survive the merge instead of cascading away with the duplicate catalog row.
  database.sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_price_index_samples (
        event_key, catalog_product_id, listing_product_id, shop_key, source_id, sample_kind,
        signal_kind, price_yen, observed_at, created_at
      ) VALUES ('retained-evidence', ?, 999000, 'shop', 'gone', 'asking', 'asking', 2000, ?, ?)
    `)
    .run(quiet, NOW, NOW);
  assert.equal(priceIndexRows(database.sqlite).length, 2);

  await converge(database.db);

  assert.deepEqual(
    priceIndexRows(database.sqlite).map((row) => [Number(row.catalog_product_id), row.count]),
    [[busy, 1]],
  );
  assert.equal(
    count(
      database.sqlite,
      "SELECT COUNT(*) AS total FROM knowledge_catalog_price_index_samples WHERE catalog_product_id = ?",
      busy,
    ),
    4,
    "retention-safe evidence moves to the survivor rather than cascading away",
  );
});

test("repeating a convergence is a no-op and never violates price index uniqueness", async () => {
  const database = emptyCatalog();
  // Equally busy, so the survivor is decided by the longest-standing verification rather than by
  // whichever row a scan happens to read first.
  const newer = insertCatalogProduct(database.sqlite, SPACED_MODEL, "2026-01-02T00:00:00.000Z");
  const older = insertCatalogProduct(database.sqlite, TIGHT_MODEL, "2026-01-01T00:00:00.000Z");
  insertMatchedListing(database.sqlite, newer, SPACED_MODEL);
  insertMatchedListing(database.sqlite, older, TIGHT_MODEL);

  await converge(database.db);
  const afterFirst = priceIndexRows(database.sqlite);
  const repeat = await converge(database.db);

  assert.deepEqual(
    { ...repeat },
    { convergedGroups: 0, removedProducts: 0, incompleteGroups: 0, hasMore: false },
  );
  assert.deepEqual(catalogProductIds(database.sqlite), [older]);
  assert.deepEqual(priceIndexRows(database.sqlite), afterFirst);
});

test("convergence resumes from a partially converged catalog", async () => {
  const database = emptyCatalog();
  const survivor = insertCatalogProduct(database.sqlite, SPACED_MODEL, "2026-01-01T00:00:00.000Z");
  const partiallyMoved = insertCatalogProduct(
    database.sqlite,
    TIGHT_MODEL,
    "2026-01-03T00:00:00.000Z",
  );
  const stillPending = insertCatalogProduct(
    database.sqlite,
    "MODEL_100",
    "2026-01-04T00:00:00.000Z",
  );
  // An interrupted pass: the survivor already owns a listing and a price index, the duplicate it
  // was merging still holds one of its own, and a third spelling was never reached.
  insertMatchedListing(database.sqlite, survivor, SPACED_MODEL);
  insertMatchedListing(database.sqlite, partiallyMoved, TIGHT_MODEL);
  insertMatchedListing(database.sqlite, stillPending, "MODEL_100");
  database.sqlite
    .prepare(`
      INSERT OR IGNORE INTO knowledge_catalog_aliases (product_id, alias, normalized_alias, alias_type, created_at)
      VALUES (?, ?, ?, 'model', ?)
    `)
    .run(survivor, TIGHT_MODEL, normalizeCatalogModel(TIGHT_MODEL), NOW);

  const result = await converge(database.db);

  assert.equal(result.convergedGroups, 1);
  assert.equal(result.removedProducts, 2);
  assert.deepEqual(catalogProductIds(database.sqlite), [survivor]);
  assert.deepEqual(
    priceIndexRows(database.sqlite).map((row) => Number(row.catalog_product_id)),
    [survivor],
  );
  assert.equal(
    count(
      database.sqlite,
      "SELECT COUNT(*) AS total FROM product_identity_resolutions WHERE catalog_product_id = ?",
      survivor,
    ),
    3,
  );
  assert.deepEqual(
    { ...(await converge(database.db)) },
    { convergedGroups: 0, removedProducts: 0, incompleteGroups: 0, hasMore: false },
  );
});
