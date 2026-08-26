import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import { listingMembershipCategoryIds } from "../src/catalog/listing-components.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { productSearchEntityConsistency } from "../src/db/product-search-entity-repository.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";

/**
 * What Phase-4 search does when remediation changes a listing's identity.
 *
 * The other search suites assert on generated SQL, which can only show that a repository emitted
 * the statement it was asked to emit. The transition this file covers is the one that is easy to
 * get wrong and impossible to see in SQL shape: resolved exact manufacturer/model peers share one
 * unresolved fallback entity until a verified Knowledge Catalog product exists, then all confirmed
 * listings have to *leave* that fallback and join the canonical entity — without stranding the old
 * entity, without double-counting themselves, and without dragging a sibling revision along.
 *
 * Everything runs through {@link refreshListingProjections}, which is the same downstream path the
 * remediation sweep uses (`data-quality-remediation-service.ts`), against the real migrated schema.
 */

const CATALOG_MANUFACTURER = "tad";
const EARLIER = "2026-07-01T00:00:00.000Z";
const LATER = "2026-07-02T00:00:00.000Z";
const LATEST = "2026-07-03T00:00:00.000Z";

interface Listing {
  readonly shopKey: string;
  readonly sourceId: string;
  readonly model: string;
  readonly priceYen: number;
  readonly seenAt: string;
}

/** Two shops listing one product, plus the revision that must never be folded into it. */
const D1000MK2_AT_SHOP_A: Listing = {
  shopKey: "shop-a",
  sourceId: "a-1",
  model: "D1000MK2",
  priceYen: 500_000,
  seenAt: EARLIER,
};
const D1000MK2_AT_SHOP_B: Listing = {
  shopKey: "shop-b",
  sourceId: "b-1",
  model: "D1000MK2",
  priceYen: 520_000,
  seenAt: LATER,
};
const D1000MK3_AT_SHOP_C: Listing = {
  shopKey: "shop-c",
  sourceId: "c-1",
  model: "D1000MK3",
  priceYen: 540_000,
  seenAt: LATEST,
};

const ALL_LISTINGS = [D1000MK2_AT_SHOP_A, D1000MK2_AT_SHOP_B, D1000MK3_AT_SHOP_C] as const;

function insertListing(sqlite: DatabaseSync, listing: Listing): number {
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
        ?, 'in_stock', ?, ?, ?, ?,
        ?, 1,
        'Technical Audio Devices', 'TECHNICALAUDIODEVICES', ?, ?,
        'resolved', ?, ?, 'resolved',
        'D/Aコンバーター', 'dac', '["dac"]', 'classified', 'DAC D/A Converter'
      )
    `)
    .run(
      listing.shopKey,
      listing.sourceId,
      listing.model,
      `TAD ${listing.model}`,
      listing.priceYen,
      `https://example.test/${listing.shopKey}/${listing.sourceId}`,
      listing.seenAt,
      listing.seenAt,
      listing.seenAt,
      listing.seenAt,
      CATALOG_MANUFACTURER,
      CATALOG_MANUFACTURER,
      listing.model,
      listing.model,
    );
  const id = Number(result.lastInsertRowid);
  // The listing write path materializes membership for every listing it stores, and the category
  // filter reads it, so a fixture that skipped it would be a listing production cannot produce.
  // Derived rather than spelled out, so a taxonomy change cannot leave this fixture behind.
  for (const categoryId of listingMembershipCategoryIds("dac", ["dac"])) {
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO product_categories(product_id, category_id, is_direct) VALUES (?, ?, ?)",
      )
      .run(id, categoryId, categoryId === "dac" ? 1 : 0);
  }
  return id;
}

/**
 * Adds a canonical product, which is what a Knowledge Catalog remediation ultimately does.
 *
 * `verificationStatus` is a parameter because the difference between a verified row and a rejected
 * one is the difference between a canonical entity and safe exact fallback grouping.
 */
function catalogProduct(
  sqlite: DatabaseSync,
  canonicalModel: string,
  verificationStatus = "verified",
): number {
  const result = sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_products(
        manufacturer_id, canonical_model, normalized_model, canonical_name,
        verification_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      CATALOG_MANUFACTURER,
      canonicalModel,
      canonicalModel,
      `TAD ${canonicalModel}`,
      verificationStatus,
      LATEST,
      LATEST,
    );
  const id = Number(result.lastInsertRowid);
  sqlite
    .prepare(
      "INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary) VALUES (?, 'dac', 1)",
    )
    .run(id);
  return id;
}

/** The remediation downstream path, run for every shop that holds one of the fixtures. */
async function refreshEverything(db: QueryableDatabase, at: string): Promise<void> {
  await refreshListingProjections(
    db,
    ALL_LISTINGS.map((listing) => ({ shop_key: listing.shopKey, source_id: listing.sourceId })),
    at,
  );
}

interface Fixture {
  readonly sqlite: DatabaseSync;
  readonly db: QueryableDatabase;
  readonly listingIds: Record<string, number>;
}

/** Three listings projected initially with an empty Knowledge Catalog. */
function arrangeUnresolved(): Fixture {
  const { sqlite, db } = migratedSqlite();
  const listingIds: Record<string, number> = {};
  for (const listing of ALL_LISTINGS) {
    listingIds[listing.shopKey] = insertListing(sqlite, listing);
  }
  return { sqlite, db, listingIds };
}

function entityKeyForListing(sqlite: DatabaseSync, listingId: number): string | null {
  const row = sqlite
    .prepare(`
      SELECT e.entity_key AS entity_key
      FROM product_search_entity_offers m
      JOIN product_search_entities e ON e.id = m.entity_id
      WHERE m.listing_product_id = ?
    `)
    .get(listingId) as { entity_key?: string } | undefined;
  return row?.entity_key ?? null;
}

function entityExists(sqlite: DatabaseSync, entityKey: string): boolean {
  return Boolean(
    sqlite
      .prepare("SELECT 1 AS present FROM product_search_entities WHERE entity_key = ?")
      .get(entityKey),
  );
}

function membershipCount(sqlite: DatabaseSync, listingId: number): number {
  const row = sqlite
    .prepare(
      "SELECT COUNT(*) AS count FROM product_search_entity_offers WHERE listing_product_id = ?",
    )
    .get(listingId) as { count?: number } | undefined;
  return Number(row?.count ?? -1);
}

test("exact unresolved peers share a fallback, then leave it for the canonical product", async () => {
  const { sqlite, db, listingIds } = arrangeUnresolved();
  await refreshEverything(db, LATEST);

  const sharedFallback = `l-${listingIds["shop-a"]}`;
  const supersededFallback = `l-${listingIds["shop-b"]}`;
  assert.equal(entityKeyForListing(sqlite, listingIds["shop-a"]), sharedFallback);
  assert.equal(entityKeyForListing(sqlite, listingIds["shop-b"]), sharedFallback);
  assert.equal(entityExists(sqlite, supersededFallback), false);

  const catalogId = catalogProduct(sqlite, "D1000MK2");
  await refreshEverything(db, LATEST);

  const canonical = `c-${catalogId}`;
  assert.equal(entityKeyForListing(sqlite, listingIds["shop-a"]), canonical);
  assert.equal(entityKeyForListing(sqlite, listingIds["shop-b"]), canonical);
  assert.equal(
    entityExists(sqlite, sharedFallback),
    false,
    "the shared fallback a confirmed product left behind must be removed, not kept empty",
  );
  assert.equal(entityExists(sqlite, supersededFallback), false);
  // The membership primary key makes a second row impossible; asserting it proves the transition
  // never tried to write one, which is what would have surfaced as an error in production.
  assert.equal(membershipCount(sqlite, listingIds["shop-a"]), 1);
  assert.equal(membershipCount(sqlite, listingIds["shop-b"]), 1);

  const aggregates = sqlite
    .prepare(`
      SELECT offer_count, shop_count, in_stock_offer_count, lowest_price_yen, highest_price_yen
      FROM product_search_entities WHERE entity_key = ?
    `)
    .get(canonical) as Record<string, number>;
  assert.deepEqual(
    { ...aggregates },
    {
      offer_count: 2,
      shop_count: 2,
      in_stock_offer_count: 2,
      lowest_price_yen: 500_000,
      highest_price_yen: 520_000,
    },
  );
});

test("the revision the remediation did not verify keeps its own product", async () => {
  const { sqlite, db, listingIds } = arrangeUnresolved();
  const catalogId = catalogProduct(sqlite, "D1000MK2");
  await refreshEverything(db, LATEST);

  const revision = listingIds["shop-c"];
  assert.equal(
    entityKeyForListing(sqlite, revision),
    `l-${revision}`,
    "MK3 must not be pulled into the MK2 product the catalog just verified",
  );
  const resolution = sqlite
    .prepare(
      "SELECT status, catalog_product_id FROM product_identity_resolutions WHERE listing_product_id = ?",
    )
    .get(revision) as { status?: string; catalog_product_id?: number | null } | undefined;
  assert.notEqual(resolution?.status, "matched");
  assert.equal(resolution?.catalog_product_id ?? null, null);
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_search_entity_offers WHERE entity_id = (SELECT id FROM product_search_entities WHERE entity_key = ?)",
      )
      .get(`c-${catalogId}`)?.count,
    2,
  );
});

test("a rejected catalog product never creates a catalog entity or overrides exact fallback grouping", async () => {
  // `knowledge_catalog_products.verification_status` only admits 'verified' or 'rejected', so an
  // unreviewed product is unrepresentable here by construction — candidates live in
  // `knowledge_catalog_candidates` until someone approves them. A rejected row must never become
  // authoritative, while the independently safe exact manufacturer/model identity may still keep
  // duplicate cards collapsed.
  const { sqlite, db, listingIds } = arrangeUnresolved();
  const rejected = catalogProduct(sqlite, "D1000MK2", "rejected");
  await refreshEverything(db, LATEST);

  const sharedFallback = `l-${listingIds["shop-a"]}`;
  assert.equal(entityExists(sqlite, `c-${rejected}`), false);
  assert.equal(entityKeyForListing(sqlite, listingIds["shop-a"]), sharedFallback);
  assert.equal(entityKeyForListing(sqlite, listingIds["shop-b"]), sharedFallback);

  // ...and verifying that same row is all it takes to promote both listings to the canonical entity.
  sqlite
    .prepare("UPDATE knowledge_catalog_products SET verification_status = 'verified' WHERE id = ?")
    .run(rejected);
  await refreshEverything(db, LATEST);

  assert.equal(entityKeyForListing(sqlite, listingIds["shop-a"]), `c-${rejected}`);
  assert.equal(entityKeyForListing(sqlite, listingIds["shop-b"]), `c-${rejected}`);
  assert.equal(entityExists(sqlite, sharedFallback), false);
});

test("verified sibling revisions stay two products rather than collapsing into one", async () => {
  const { sqlite, db, listingIds } = arrangeUnresolved();
  const mk2 = catalogProduct(sqlite, "D1000MK2");
  const mk3 = catalogProduct(sqlite, "D1000MK3");
  await refreshEverything(db, LATEST);

  assert.equal(entityKeyForListing(sqlite, listingIds["shop-a"]), `c-${mk2}`);
  assert.equal(entityKeyForListing(sqlite, listingIds["shop-b"]), `c-${mk2}`);
  assert.equal(entityKeyForListing(sqlite, listingIds["shop-c"]), `c-${mk3}`);

  const response = await searchProducts(db, productQuery("?q=TAD%20D1000&includeTotal=true"));
  assert.equal(response.totalCount, 2);
  assert.deepEqual(
    response.items.map((item) => item.model).sort(),
    ["D1000MK2", "D1000MK3"],
    "each verified revision must remain its own search result",
  );
});

test("search reports the remediated product once, with both shops' offers", async () => {
  const { sqlite, db } = arrangeUnresolved();
  catalogProduct(sqlite, "D1000MK2");
  await refreshEverything(db, LATEST);

  const response = await searchProducts(db, productQuery("?q=D1000MK2&includeTotal=true"));
  assert.equal(response.totalCount, 1);
  assert.equal(response.items.length, 1);
  const [product] = response.items;
  assert.equal(product.identity_kind, "catalog");
  assert.equal(product.offer_count, 2);
  assert.equal(product.shop_count, 2);
  assert.equal(product.lowest_price_yen, 500_000);
  assert.equal(product.representative_offer?.price_yen, 500_000);
  assert.equal(product.representative_offer?.shop_key, "shop-a");
});

test("filters still describe the offers behind the remediated product", async () => {
  const { sqlite, db } = arrangeUnresolved();
  catalogProduct(sqlite, "D1000MK2");
  await refreshEverything(db, LATEST);

  const byShop = await searchProducts(db, productQuery("?shop=shop-b&includeTotal=true"));
  assert.equal(byShop.totalCount, 1, "the merged product is reachable through either of its shops");
  assert.equal(byShop.items[0]?.model, "D1000MK2");
  // Card numbers are recomputed over the filtered offers, so shop-b's view shows only its own.
  assert.equal(byShop.items[0]?.offer_count, 1);
  assert.equal(byShop.items[0]?.lowest_price_yen, 520_000);

  const byManufacturer = await searchProducts(db, productQuery("?manufacturer=tad"));
  assert.deepEqual(byManufacturer.items.map((item) => item.model).sort(), ["D1000MK2", "D1000MK3"]);

  const byCategory = await searchProducts(db, productQuery("?category=dac&includeTotal=true"));
  assert.equal(byCategory.totalCount, 2);

  const byPrice = await searchProducts(db, productQuery("?maxPrice=510000&includeTotal=true"));
  assert.equal(byPrice.totalCount, 1, "only the 500,000 offer clears the ceiling");
  assert.equal(byPrice.items[0]?.model, "D1000MK2");
});

test("sort and pagination page over remediated products without repeating or losing one", async () => {
  const { sqlite, db } = arrangeUnresolved();
  catalogProduct(sqlite, "D1000MK2");
  await refreshEverything(db, LATEST);

  const ascending = await searchProducts(db, productQuery("?sort=priceAsc"));
  assert.deepEqual(
    ascending.items.map((item) => item.lowest_price_yen),
    [500_000, 540_000],
  );

  const firstPage = await searchProducts(db, productQuery("?sort=priceAsc&limit=1"));
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  const secondPage = await searchProducts(
    db,
    productQuery(`?sort=priceAsc&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`),
  );
  assert.equal(secondPage.hasMore, false);
  assert.deepEqual(
    [...firstPage.items, ...secondPage.items].map((item) => item.key),
    ascending.items.map((item) => item.key),
    "keyset paging must visit each product exactly once, in the unpaged order",
  );
});

test("the projection reports no drift once a remediation has moved a listing", async () => {
  const { sqlite, db } = arrangeUnresolved();
  await refreshEverything(db, LATEST);
  catalogProduct(sqlite, "D1000MK2");
  await refreshEverything(db, LATEST);

  assert.deepEqual(await productSearchEntityConsistency(db), {
    unmembered_active_listings: 0,
    inactive_offer_memberships: 0,
    entities_without_offers: 0,
    stale_fallback_entities: 0,
    ineligible_catalog_entities: 0,
    offer_count_mismatches: 0,
    fts_integrity_ok: true,
    ok: true,
  });
});

test("replaying the same remediation twice changes nothing", async () => {
  const { sqlite, db, listingIds } = arrangeUnresolved();
  catalogProduct(sqlite, "D1000MK2");
  await refreshEverything(db, LATEST);

  const snapshot = () =>
    JSON.stringify(
      sqlite
        .prepare(`
          SELECT e.entity_key, e.offer_count, e.shop_count, e.lowest_price_yen,
                 m.listing_product_id
          FROM product_search_entities e
          JOIN product_search_entity_offers m ON m.entity_id = e.id
          ORDER BY e.entity_key, m.listing_product_id
        `)
        .all(),
    );

  const afterFirst = snapshot();
  await refreshEverything(db, LATEST);
  assert.equal(snapshot(), afterFirst);
  assert.equal(membershipCount(sqlite, listingIds["shop-a"]), 1);
});
