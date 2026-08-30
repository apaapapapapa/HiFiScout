import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { normalizeCatalogModel } from "../src/catalog/knowledge-catalog.js";
import { manufacturerIdForFilter } from "../src/catalog/manufacturers.js";
import { normalizeIdentityModel } from "../src/catalog/product-identity.js";
import { mergeKnowledgeCatalogAdminProducts } from "../src/db/knowledge-catalog-admin-operations.js";
import {
  duplicateBucketKeySql,
  listKnowledgeCatalogDuplicates,
} from "../src/db/knowledge-catalog-duplicate-repository.js";
import { parseKnowledgeCatalogDuplicateListQuery } from "../src/http/knowledge-catalog-admin.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const NOW = "2026-01-05T00:00:00.000Z";

type Sqlite = ReturnType<typeof migratedSqlite>["sqlite"];

interface CatalogSeed {
  manufacturerId: string;
  canonicalModel: string;
  canonicalName?: string;
  verificationStatus?: "verified" | "rejected";
  primaryCategoryId?: string;
  matchedListings?: number;
  firstVerifiedAt?: string;
}

/** Migrations seed real catalog rows, so every case starts from an empty catalog. */
function emptyCatalog(): ReturnType<typeof migratedSqlite> {
  const database = migratedSqlite();
  database.sqlite.exec(`
    DELETE FROM product_search_entity_offers;
    DELETE FROM product_search_entities;
    DELETE FROM product_identity_resolutions;
    DELETE FROM knowledge_catalog_verification_attempts;
    DELETE FROM knowledge_catalog_candidates;
    DELETE FROM knowledge_catalog_products;
    DELETE FROM products;
  `);
  return database;
}

let nextListingId = 0;

/**
 * A seller listing carrying the identity fields the resolver reads, so a merge that replays
 * identity resolution re-matches it instead of dropping it for want of fixture data.
 */
function insertMatchedListings(
  sqlite: Sqlite,
  catalogProductId: number,
  count: number,
  seed: CatalogSeed,
): void {
  const manufacturerId = manufacturerIdForFilter(seed.manufacturerId);
  const identityModel = normalizeIdentityModel(seed.canonicalModel);
  for (let index = 0; index < count; index += 1) {
    nextListingId += 1;
    const sourceId = `listing-${nextListingId}`;
    const listingId = Number(
      sqlite
        .prepare(`
          INSERT INTO products (
            shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at,
            is_active, manufacturer, raw_manufacturer, manufacturer_id, canonical_manufacturer_id,
            manufacturer_resolution_status, model, raw_model, normalized_model,
            model_resolution_status, primary_category_id, category_ids, classification_status
          ) VALUES ('shop', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'resolved', ?, ?, ?, 'resolved',
                    'AMP.INTEGRATED', '["AMP.INTEGRATED"]', 'classified')
        `)
        .run(
          sourceId,
          `${seed.manufacturerId} ${seed.canonicalModel}`,
          `https://example.test/${sourceId}`,
          NOW,
          NOW,
          NOW,
          seed.manufacturerId,
          seed.manufacturerId,
          manufacturerId,
          manufacturerId,
          seed.canonicalModel,
          seed.canonicalModel,
          identityModel,
        ).lastInsertRowid,
    );
    sqlite
      .prepare(`
        INSERT INTO product_identity_resolutions (
          listing_product_id, catalog_product_id, status, match_method, confidence, evaluated_at
        ) VALUES (?, ?, 'matched', 'test', 'high', ?)
      `)
      .run(listingId, catalogProductId, NOW);
  }
}

function insertCatalog(sqlite: Sqlite, seed: CatalogSeed): number {
  const productId = Number(
    sqlite
      .prepare(`
        INSERT INTO knowledge_catalog_products (
          manufacturer_id, canonical_model, normalized_model, canonical_name, lifecycle_status,
          verification_status, review_status, first_verified_at, last_verified_at, created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 'unknown', ?, 'current', ?, ?, ?, ?)
      `)
      .run(
        seed.manufacturerId,
        seed.canonicalModel,
        normalizeCatalogModel(seed.canonicalModel),
        seed.canonicalName ?? `${seed.manufacturerId} ${seed.canonicalModel}`,
        seed.verificationStatus ?? "verified",
        seed.firstVerifiedAt ?? NOW,
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
    .run(productId, seed.primaryCategoryId ?? "AMP.INTEGRATED");
  insertMatchedListings(sqlite, productId, seed.matchedListings ?? 0, seed);
  return productId;
}

const ALL = { manufacturerId: "", afterKey: "", limit: 20 };

test("duplicate bucket key folds the separators and revisions the identity model drops", () => {
  const sql = duplicateBucketKeySql("kp.normalized_model");
  assert.match(sql, /REPLACE\(.*, '-', ''\)/u);
  assert.match(sql, /REPLACE\(.*, ' ', ''\)/u);
  // Longest first, so MKIII never decays into MK2 plus a stray I.
  assert.ok(
    sql.indexOf("'MKIII'") < sql.indexOf("'MKII'"),
    "MKIII must be folded before the MKII prefix consumes it",
  );
  assert.ok(sql.indexOf("'MARKII'") < sql.indexOf("'MARKI'"));
});

test("catalog duplicates group separator and revision spellings of one model", async () => {
  const { sqlite, db } = emptyCatalog();
  const spaced = insertCatalog(sqlite, { manufacturerId: "denon", canonicalModel: "PMA-2500NE" });
  const tight = insertCatalog(sqlite, { manufacturerId: "denon", canonicalModel: "PMA2500NE" });
  const marked = insertCatalog(sqlite, { manufacturerId: "luxman", canonicalModel: "L-509 MK II" });
  const compact = insertCatalog(sqlite, { manufacturerId: "luxman", canonicalModel: "L-509MKII" });

  const result = await listKnowledgeCatalogDuplicates(db, ALL);

  assert.deepEqual(
    result.items.map((group) => [
      group.manufacturerId,
      group.identityModel,
      group.products.map((product) => product.id),
    ]),
    [
      ["luxman", "L509MK2", [marked, compact]],
      ["denon", "PMA2500NE", [spaced, tight]],
    ],
  );
  assert.equal(result.hasMore, false);
  assert.equal(result.nextAfterKey, null);
});

test("catalog duplicates group catalogs stored under a legacy manufacturer id", async () => {
  const { sqlite, db } = emptyCatalog();
  const canonical = insertCatalog(sqlite, {
    manufacturerId: "bowers-wilkins",
    canonicalModel: "805 D4",
  });
  const legacy = insertCatalog(sqlite, { manufacturerId: "bw", canonicalModel: "805D4" });

  const result = await listKnowledgeCatalogDuplicates(db, ALL);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].manufacturerId, "bowers-wilkins");
  assert.deepEqual(
    result.items[0].products.map((product) => product.id),
    [canonical, legacy],
  );
});

test("catalog duplicates never group one model across two manufacturers", async () => {
  const { sqlite, db } = emptyCatalog();
  insertCatalog(sqlite, { manufacturerId: "onkyo", canonicalModel: "A-10" });
  insertCatalog(sqlite, { manufacturerId: "accuphase", canonicalModel: "A10" });

  const result = await listKnowledgeCatalogDuplicates(db, ALL);

  assert.deepEqual(result.items, []);
});

test("catalog duplicates ignore rejected catalogs and models with no identity", async () => {
  const { sqlite, db } = emptyCatalog();
  insertCatalog(sqlite, { manufacturerId: "denon", canonicalModel: "PMA-2500NE" });
  insertCatalog(sqlite, {
    manufacturerId: "denon",
    canonicalModel: "PMA2500NE",
    verificationStatus: "rejected",
  });
  insertCatalog(sqlite, { manufacturerId: "luxman", canonicalModel: "アンプ" });
  insertCatalog(sqlite, { manufacturerId: "accuphase", canonicalModel: "アンプ" });

  const result = await listKnowledgeCatalogDuplicates(db, ALL);

  assert.deepEqual(result.items, []);
});

test("catalog duplicates suggest the busiest, longest-standing catalog as the survivor", async () => {
  const { sqlite, db } = emptyCatalog();
  const quiet = insertCatalog(sqlite, {
    manufacturerId: "esoteric",
    canonicalModel: "K-01XD",
    firstVerifiedAt: "2025-01-01T00:00:00.000Z",
    matchedListings: 1,
  });
  const busy = insertCatalog(sqlite, {
    manufacturerId: "esoteric",
    canonicalModel: "K01XD",
    firstVerifiedAt: "2026-01-01T00:00:00.000Z",
    matchedListings: 4,
  });

  const result = await listKnowledgeCatalogDuplicates(db, ALL);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].suggestedTargetId, busy);
  assert.deepEqual(
    result.items[0].products.map((product) => [product.id, product.matchedListingCount]),
    [
      [quiet, 1],
      [busy, 4],
    ],
  );
});

test("catalog duplicates count the aliases and sources a merge would move", async () => {
  const { sqlite, db } = emptyCatalog();
  const target = insertCatalog(sqlite, { manufacturerId: "marantz", canonicalModel: "SA-10" });
  insertCatalog(sqlite, { manufacturerId: "marantz", canonicalModel: "SA10" });
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_aliases (product_id, alias, normalized_alias, alias_type, created_at)
      VALUES (?, 'SA-10SE', 'SA-10SE', 'model', ?)
    `)
    .run(target, NOW);
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_sources (
        product_id, source_type, source_url, content_hash, status, created_at, updated_at
      ) VALUES (?, 'manual_verified', 'https://example.test/sa-10', '', 'active', ?, ?)
    `)
    .run(target, NOW, NOW);

  const result = await listKnowledgeCatalogDuplicates(db, ALL);

  const found = result.items[0].products.find((product) => product.id === target);
  assert.equal(found?.aliasCount, 1);
  assert.equal(found?.sourceCount, 1);
});

test("catalog duplicates narrow to one manufacturer without losing its legacy ids", async () => {
  const { sqlite, db } = emptyCatalog();
  insertCatalog(sqlite, { manufacturerId: "bowers-wilkins", canonicalModel: "805 D4" });
  insertCatalog(sqlite, { manufacturerId: "bw", canonicalModel: "805D4" });
  insertCatalog(sqlite, { manufacturerId: "denon", canonicalModel: "PMA-2500NE" });
  insertCatalog(sqlite, { manufacturerId: "denon", canonicalModel: "PMA2500NE" });

  const result = await listKnowledgeCatalogDuplicates(db, {
    ...ALL,
    manufacturerId: "bowers-wilkins",
  });

  assert.deepEqual(
    result.items.map((group) => group.identityModel),
    ["805D4"],
  );
});

test("catalog duplicates page whole groups and resume from the returned cursor", async () => {
  const { sqlite, db } = emptyCatalog();
  for (const model of ["AAA-1", "BBB-1", "CCC-1"]) {
    insertCatalog(sqlite, { manufacturerId: "luxman", canonicalModel: model });
    insertCatalog(sqlite, { manufacturerId: "luxman", canonicalModel: model.replace("-", "") });
  }

  const first = await listKnowledgeCatalogDuplicates(db, { ...ALL, limit: 1 });
  assert.deepEqual(
    first.items.map((group) => group.identityModel),
    ["AAA1"],
  );
  assert.equal(first.items[0].products.length, 2, "a group is never split across pages");
  assert.equal(first.hasMore, true);
  assert.equal(first.nextAfterKey, "AAA1");

  const second = await listKnowledgeCatalogDuplicates(db, {
    ...ALL,
    limit: 1,
    afterKey: first.nextAfterKey || "",
  });
  assert.deepEqual(
    second.items.map((group) => group.identityModel),
    ["BBB1"],
  );

  const third = await listKnowledgeCatalogDuplicates(db, {
    ...ALL,
    limit: 1,
    afterKey: second.nextAfterKey || "",
  });
  assert.deepEqual(
    third.items.map((group) => group.identityModel),
    ["CCC1"],
  );
  assert.equal(third.hasMore, false);
  assert.equal(third.nextAfterKey, null);
});

test("merging a reported duplicate clears it from review and keeps the identities", async () => {
  const { sqlite, db } = emptyCatalog();
  const target = insertCatalog(sqlite, {
    manufacturerId: "denon",
    canonicalModel: "PMA-2500NE",
    matchedListings: 2,
  });
  const source = insertCatalog(sqlite, {
    manufacturerId: "denon",
    canonicalModel: "PMA2500NE",
    matchedListings: 1,
  });

  const before = await listKnowledgeCatalogDuplicates(db, ALL);
  assert.equal(before.items.length, 1);
  assert.equal(before.items[0].suggestedTargetId, target);

  const merged = await mergeKnowledgeCatalogAdminProducts(db, target, source, NOW);
  assert.equal(merged?.removedProductId, source);
  assert.equal(merged?.movedMatchedListings, 1);

  const after = await listKnowledgeCatalogDuplicates(db, ALL);
  assert.deepEqual(after.items, []);
  assert.equal(
    (
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_products WHERE id = ?")
        .get(source) as { count: number }
    ).count,
    0,
    "the merged-away catalog row is deleted",
  );
  assert.equal(
    (
      sqlite
        .prepare(`
          SELECT COUNT(*) AS count
          FROM product_identity_resolutions
          WHERE catalog_product_id = ? AND status = 'matched'
        `)
        .get(target) as { count: number }
    ).count,
    3,
    "both catalogs' matched listings survive on the surviving catalog",
  );
});

test("duplicate list query validates the cursor and the page size", () => {
  const base = "https://example.test/api/admin/knowledge-catalog/duplicates";
  assert.deepEqual(parseKnowledgeCatalogDuplicateListQuery(new URL(base)), {
    manufacturerId: "",
    afterKey: "",
    limit: 20,
  });
  assert.deepEqual(
    parseKnowledgeCatalogDuplicateListQuery(
      new URL(`${base}?manufacturerId=LUXMAN&afterKey=L509MK2&limit=5`),
    ),
    { manufacturerId: "luxman", afterKey: "L509MK2", limit: 5 },
  );
  assert.equal(parseKnowledgeCatalogDuplicateListQuery(new URL(`${base}?limit=51`)), null);
  assert.equal(parseKnowledgeCatalogDuplicateListQuery(new URL(`${base}?limit=0`)), null);
  assert.equal(
    parseKnowledgeCatalogDuplicateListQuery(new URL(`${base}?manufacturerId=not a brand`)),
    null,
  );
  assert.equal(
    parseKnowledgeCatalogDuplicateListQuery(
      new URL(`${base}?afterKey=${encodeURIComponent("A\u0001B")}`),
    ),
    null,
  );
  assert.equal(
    parseKnowledgeCatalogDuplicateListQuery(new URL(`${base}?afterKey=${"x".repeat(301)}`)),
    null,
  );
});
