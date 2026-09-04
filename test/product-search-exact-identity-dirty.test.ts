import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { queryPlan, readsThroughIndex, recordingDatabase } from "./helpers/query-plan.js";
import {
  countDirtyExactIdentityBacklog,
  DIRTY_IDENTITY_LEASE_MS,
  repairDirtyExactIdentities,
} from "../src/db/product-search-exact-identity-dirty.js";

const AT = "2026-09-02T00:00:00.000Z";

interface ListingFixture {
  id: number;
  shopKey?: string;
  manufacturerId?: string;
  normalizedModel?: string;
  categoryId?: string;
  isActive?: 0 | 1;
  modelStatus?: string;
}

function insertListing(sqlite: DatabaseSync, listing: ListingFixture): void {
  const {
    id,
    shopKey = "shop-a",
    manufacturerId = "luxman",
    normalizedModel = "c10",
    categoryId = "amplifier",
    isActive = 1,
    modelStatus = "resolved",
  } = listing;
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
        ?, ?, ?, 'Example', 'Example', ?, ?, 'resolved', ?, ?, ?, ?, ?, ?, ?, ?,
        json_array(?), json_array(?), 'classified', '[]', 'used', 100000, 'in_stock', ?,
        ?, ?, ?, ?, ?, '{}'
      )
    `)
    .run(
      id,
      shopKey,
      `src-${id}`,
      manufacturerId,
      manufacturerId,
      normalizedModel,
      normalizedModel,
      normalizedModel,
      modelStatus,
      `Listing ${id}`,
      categoryId,
      categoryId,
      categoryId,
      categoryId,
      categoryId,
      `https://example.test/${id}`,
      AT,
      AT,
      AT,
      AT,
      isActive,
    );
}

/** Puts each listing in its own fallback entity, which is exactly the split state to be repaired. */
function splitIntoSeparateEntities(sqlite: DatabaseSync, listingIds: readonly number[]): void {
  for (const listingId of listingIds) {
    sqlite
      .prepare(`
        INSERT INTO product_search_entities (
          entity_key, entity_kind, fallback_listing_id, manufacturer_id, normalized_model
        )
        VALUES (?, 'unresolved_listing', ?, 'luxman', 'c10')
      `)
      .run(`l-${listingId}`, listingId);
    sqlite
      .prepare(`
        INSERT INTO product_search_entity_offers (listing_product_id, entity_id, shop_key)
        SELECT ?, id, 'shop-a' FROM product_search_entities WHERE entity_key = ?
      `)
      .run(listingId, `l-${listingId}`);
  }
}

function dirtyRows(sqlite: DatabaseSync): { key: string; claimed: string | null }[] {
  return sqlite
    .prepare(`
      SELECT canonical_manufacturer_id || '|' || normalized_model AS key, claimed_at AS claimed
      FROM product_search_exact_identity_dirty
      ORDER BY key
    `)
    .all() as { key: string; claimed: string | null }[];
}

function clearDirty(sqlite: DatabaseSync): void {
  sqlite.exec("DELETE FROM product_search_exact_identity_dirty");
}

test("inserting a listing marks its identity dirty", () => {
  const { sqlite } = migratedSqlite();
  clearDirty(sqlite);
  insertListing(sqlite, { id: 1 });

  assert.deepEqual(
    dirtyRows(sqlite).map((row) => row.key),
    ["luxman|c10"],
  );
});

test("a listing leaving an identity marks the identity it left as well as the one it joined", () => {
  // The peers left behind are the ones whose grouping can now be wrong, and nothing else names them.
  const { sqlite } = migratedSqlite();
  insertListing(sqlite, { id: 1, normalizedModel: "c10" });
  clearDirty(sqlite);

  sqlite.prepare("UPDATE products SET normalized_model = 'c10x' WHERE id = ?").run(1);

  assert.deepEqual(
    dirtyRows(sqlite).map((row) => row.key),
    ["luxman|c10", "luxman|c10x"],
  );
});

test("changes that only affect membership still mark the identity", () => {
  const { sqlite } = migratedSqlite();
  insertListing(sqlite, { id: 1 });

  for (const [column, value] of [
    ["is_active", 0],
    ["model_resolution_status", "unresolved"],
    ["primary_category_id", "speaker"],
  ] as const) {
    clearDirty(sqlite);
    sqlite.prepare(`UPDATE products SET ${column} = ? WHERE id = 1`).run(value);
    assert.deepEqual(
      dirtyRows(sqlite).map((row) => row.key),
      ["luxman|c10"],
      `${column} should mark the identity dirty`,
    );
  }
});

test("repeated writes to one identity collapse onto a single dirty row", () => {
  // A crawl rewrites the same listings constantly. If each write queued work the backlog would grow
  // with crawl volume rather than with the number of identities that actually changed.
  const { sqlite } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  insertListing(sqlite, { id: 2 });
  for (let round = 0; round < 5; round += 1) {
    sqlite.prepare("UPDATE products SET primary_category_id = 'amplifier'").run();
  }

  assert.equal(dirtyRows(sqlite).length, 1);
});

test("a split identity group is collapsed onto one entity", async () => {
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  insertListing(sqlite, { id: 2 });
  splitIntoSeparateEntities(sqlite, [1, 2]);

  const result = await repairDirtyExactIdentities(db, { countBacklog: true });

  assert.equal(result.claimedIdentities, 1);
  assert.equal(result.repairedIdentities, 1);
  assert.equal(result.failedIdentities, 0);
  assert.equal(result.backlog, 0, "a repaired identity leaves the queue");

  const entityIds = sqlite
    .prepare("SELECT DISTINCT entity_id FROM product_search_entity_offers")
    .all();
  assert.equal(entityIds.length, 1, "both listings should share one entity");
});

test("an identity that is not split is cleared without a resync", async () => {
  // The common case by far: most changes do not split a group, and paying for a rebuild on each one
  // would put back the cost this replaces.
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1 });

  const result = await repairDirtyExactIdentities(db);

  assert.equal(result.claimedIdentities, 1);
  assert.equal(result.repairedIdentities, 0);
  assert.equal(result.cleanIdentities, 1);
  assert.equal(dirtyRows(sqlite).length, 0);
});

test("conflicting categories veto the group instead of merging it", async () => {
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1, categoryId: "amplifier" });
  insertListing(sqlite, { id: 2, categoryId: "speaker" });
  splitIntoSeparateEntities(sqlite, [1, 2]);

  const result = await repairDirtyExactIdentities(db);

  assert.equal(result.repairedIdentities, 0, "exact text identity is not enough across categories");
  const entityIds = sqlite
    .prepare("SELECT DISTINCT entity_id FROM product_search_entity_offers")
    .all();
  assert.equal(entityIds.length, 2, "the listings must stay in separate entities");
});

test("repeating a pass is idempotent and does not requeue work", async () => {
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  insertListing(sqlite, { id: 2 });
  splitIntoSeparateEntities(sqlite, [1, 2]);

  await repairDirtyExactIdentities(db);
  const second = await repairDirtyExactIdentities(db, { countBacklog: true });

  assert.equal(second.claimedIdentities, 0, "nothing is left to claim");
  assert.equal(second.backlog, 0);
  const entityIds = sqlite
    .prepare("SELECT DISTINCT entity_id FROM product_search_entity_offers")
    .all();
  assert.equal(entityIds.length, 1);
});

test("an identity re-dirtied mid-repair survives the clearing delete", async () => {
  // The claim timestamp is the token. A trigger firing during the repair resets claimed_at, so the
  // delete must miss and the newer state must be repaired on the next pass rather than dropped.
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  const claimedAt = new Date("2026-09-02T01:00:00.000Z");
  sqlite
    .prepare(`
      UPDATE product_search_exact_identity_dirty SET claimed_at = ?
    `)
    .run(claimedAt.toISOString());

  // A different pass claimed it; this pass must not delete a claim it does not own.
  const result = await repairDirtyExactIdentities(db, {
    now: new Date(claimedAt.getTime() + 1000),
  });

  assert.equal(result.claimedIdentities, 0, "a claimed identity is not claimed twice");
  assert.equal(dirtyRows(sqlite).length, 1, "the other pass's claim is untouched");
});

test("a claim abandoned by a killed isolate is returned to the queue", async () => {
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  const abandonedAt = new Date("2026-09-02T01:00:00.000Z");
  sqlite
    .prepare("UPDATE product_search_exact_identity_dirty SET claimed_at = ?")
    .run(abandonedAt.toISOString());

  const result = await repairDirtyExactIdentities(db, {
    now: new Date(abandonedAt.getTime() + DIRTY_IDENTITY_LEASE_MS + 1000),
  });

  assert.equal(result.releasedStaleClaims, 1);
  assert.equal(result.claimedIdentities, 1, "the released identity is picked up in the same pass");
  assert.equal(dirtyRows(sqlite).length, 0);
});

test("the queue drains oldest mark first", async () => {
  // Fairness matters because re-marking preserves marked_at: without ordering, a constantly
  // rewritten identity could keep a quiet one waiting indefinitely.
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1, normalizedModel: "newer" });
  insertListing(sqlite, { id: 2, normalizedModel: "older" });
  sqlite
    .prepare(
      "UPDATE product_search_exact_identity_dirty SET marked_at = ? WHERE normalized_model = 'older'",
    )
    .run("2020-01-01T00:00:00.000Z");

  const result = await repairDirtyExactIdentities(db, { limit: 1 });

  assert.equal(result.claimedIdentities, 1);
  const remaining = dirtyRows(sqlite);
  assert.deepEqual(
    remaining.map((row) => row.key),
    ["luxman|newer"],
    "the older mark should have been taken first",
  );
});

test("promoting a catalog product marks the identities of the listings it matched", async () => {
  // Verification flips on the catalog side without touching products or resolutions, and it retires
  // those listings from fallback grouping -- so the groups they were in have to be revisited.
  const { sqlite } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_products
        (id, manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at)
      VALUES (90001, 'dirty-set-test', 'C-10', 'dirtysetmodel', 'Dirty Set Test C-10', ?, ?)
    `)
    .run(AT, AT);
  sqlite
    .prepare(`
      INSERT INTO product_identity_resolutions
        (listing_product_id, catalog_product_id, status, match_method, confidence, evaluated_at)
      VALUES (1, 90001, 'matched', 'exact', 'high', ?)
    `)
    .run(AT);
  clearDirty(sqlite);

  sqlite
    .prepare(
      "UPDATE knowledge_catalog_products SET verification_status = 'verified' WHERE id = 90001",
    )
    .run();

  assert.deepEqual(
    dirtyRows(sqlite).map((row) => row.key),
    ["luxman|c10"],
  );
});

test("the per-identity member lookup reads through the identity index, not the table", async () => {
  // This is the performance claim in one assertion. The scan this replaces has no index available
  // to it at all: its predicate joins `products` to itself on identity, so its cost is the catalog.
  // Fixing the identity first is what turns the same question into a bounded index search -- and an
  // index that exists proves nothing about whether the planner picks it, so explain the statement
  // the repository actually issued.
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  insertListing(sqlite, { id: 2 });
  splitIntoSeparateEntities(sqlite, [1, 2]);
  const recording = recordingDatabase(db);

  await repairDirtyExactIdentities(recording.db);

  const memberLookup = recording.executed.find((statement) =>
    /FROM products p\s+LEFT JOIN product_search_entity_offers/u.test(statement.sql),
  );
  assert.ok(memberLookup, "the pass should have looked up the identity's members");
  assert.equal(
    readsThroughIndex(queryPlan(sqlite, memberLookup), "p", "idx_products_exact_identity"),
    true,
  );
});

test("dirty repair work does not grow with unrelated active catalog size", async () => {
  // D1's rows_read metadata is not available from the local SQLite adapter, so lock the structural
  // proxies that determine it: one claimed identity, one indexed member lookup, and a constant
  // statement count while the active catalog grows by two orders of magnitude.
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  insertListing(sqlite, { id: 2 });

  let inserted = 2;
  const observations: { activeListings: number; statements: number; memberLookups: number }[] = [];
  for (const activeListings of [100, 1_000, 10_000]) {
    sqlite.exec("BEGIN");
    while (inserted < activeListings) {
      inserted += 1;
      insertListing(sqlite, {
        id: inserted,
        manufacturerId: "unrelated",
        normalizedModel: "unrelated",
      });
    }
    sqlite.exec("COMMIT");

    clearDirty(sqlite);
    sqlite
      .prepare(`
        INSERT INTO product_search_exact_identity_dirty (
          canonical_manufacturer_id, normalized_model, marked_at
        ) VALUES ('luxman', 'c10', ?)
      `)
      .run(AT);
    const recording = recordingDatabase(db);

    const result = await repairDirtyExactIdentities(recording.db);
    const memberLookups = recording.executed.filter((statement) =>
      /FROM products p\s+LEFT JOIN product_search_entity_offers/u.test(statement.sql),
    );

    assert.equal(result.claimedIdentities, 1);
    assert.equal(result.cleanIdentities, 1);
    assert.equal(memberLookups.length, 1, "one changed identity should issue one member lookup");
    assert.equal(
      readsThroughIndex(queryPlan(sqlite, memberLookups[0]), "p", "idx_products_exact_identity"),
      true,
    );
    observations.push({
      activeListings,
      statements: recording.executed.length,
      memberLookups: memberLookups.length,
    });
  }

  assert.deepEqual(
    observations,
    [
      { activeListings: 100, statements: 5, memberLookups: 1 },
      { activeListings: 1_000, statements: 5, memberLookups: 1 },
      { activeListings: 10_000, statements: 5, memberLookups: 1 },
    ],
    "normal repair must remain O(changed identities), not O(active listings)",
  );
});

test("a group that stops being groupable is taken apart, not left consolidated", async () => {
  // The scan predicate only finds groups that need merging. A change recorded by the triggers just
  // as often means the opposite, and consolidated-but-wrong is one entity, so a split test calls it
  // clean -- and clearing the claim would then delete the only signal that anything moved.
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1, categoryId: "amplifier" });
  insertListing(sqlite, { id: 2, categoryId: "amplifier" });
  splitIntoSeparateEntities(sqlite, [1, 2]);
  await repairDirtyExactIdentities(db);

  const grouped = sqlite
    .prepare("SELECT DISTINCT entity_id FROM product_search_entity_offers")
    .all();
  assert.equal(grouped.length, 1, "precondition: the two listings start out grouped");

  sqlite.prepare("UPDATE products SET primary_category_id = 'speaker' WHERE id = 2").run();
  const result = await repairDirtyExactIdentities(db);

  assert.equal(result.repairedIdentities, 1, "conflicting categories must break the group up");
  const separated = sqlite
    .prepare("SELECT DISTINCT entity_id FROM product_search_entity_offers")
    .all();
  assert.equal(separated.length, 2);
});

test("the migration seeds the identities that already exist", () => {
  // Without this the change-driven pass would never look at the drift already in production, and
  // every repair the safety-net scan made would be indistinguishable from a trigger that misfired.
  const { sqlite } = migratedSqlite();
  clearDirty(sqlite);
  insertListing(sqlite, { id: 1 });
  insertListing(sqlite, { id: 2, normalizedModel: "c10x" });

  // Replaying the seed statement is what the migration does on a database that already has rows.
  sqlite.exec(`
    INSERT INTO product_search_exact_identity_dirty(
      canonical_manufacturer_id, normalized_model, marked_at
    )
    SELECT p.canonical_manufacturer_id, p.normalized_model,
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM products p
    WHERE p.is_active = 1
      AND p.model_resolution_status = 'resolved'
      AND COALESCE(p.canonical_manufacturer_id, '') <> ''
      AND COALESCE(p.normalized_model, '') <> ''
    GROUP BY p.canonical_manufacturer_id, p.normalized_model
    ON CONFLICT(canonical_manufacturer_id, normalized_model) DO NOTHING
  `);

  assert.deepEqual(
    dirtyRows(sqlite).map((row) => row.key),
    ["luxman|c10", "luxman|c10x"],
  );
});

test("the backlog count is what separates a trigger miss from ordinary queue depth", async () => {
  const { sqlite, db } = migratedSqlite();
  clearDirty(sqlite);
  assert.equal(await countDirtyExactIdentityBacklog(db), 0);

  insertListing(sqlite, { id: 1 });
  assert.equal(await countDirtyExactIdentityBacklog(db), 1);

  await repairDirtyExactIdentities(db);
  assert.equal(
    await countDirtyExactIdentityBacklog(db),
    0,
    "a drained queue makes a scan repair unambiguous",
  );
});

test("rewriting a listing without changing its identity leaves the queue alone", () => {
  // `AFTER UPDATE OF` fires on assignment, not on difference, and the crawl write path sets every
  // column of a changed listing in one statement. Without the WHEN clause a price move marked the
  // identity dirty, which made the cost track changed listings rather than changed identities.
  const { sqlite } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  clearDirty(sqlite);

  // The shape of the real crawl update: identity columns re-assigned to the values already stored,
  // alongside the fields that actually moved.
  sqlite
    .prepare(`
      UPDATE products SET
        canonical_manufacturer_id = 'luxman', normalized_model = 'c10',
        model_resolution_status = 'resolved', primary_category_id = 'amplifier',
        is_active = 1, price_yen = 250000, last_seen_at = ?
      WHERE id = 1
    `)
    .run("2026-09-03T00:00:00.000Z");

  assert.deepEqual(dirtyRows(sqlite), [], "a price move is not an identity change");
});

test("a real identity change still marks, even alongside untouched columns", () => {
  const { sqlite } = migratedSqlite();
  insertListing(sqlite, { id: 1 });
  clearDirty(sqlite);

  sqlite
    .prepare(`
      UPDATE products SET
        canonical_manufacturer_id = 'luxman', normalized_model = 'c10x',
        model_resolution_status = 'resolved', primary_category_id = 'amplifier', is_active = 1
      WHERE id = 1
    `)
    .run();

  assert.deepEqual(
    dirtyRows(sqlite).map((row) => row.key),
    ["luxman|c10", "luxman|c10x"],
  );
});

test("only the drifted members are seeded, and peers converge the rest", async () => {
  // The seed set is the drifted members, not the group. In the groupable case peer expansion already
  // reaches every member across every shop, so seeding the whole group only made this run once per
  // shop over the same union.
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1, shopKey: "shop-a" });
  insertListing(sqlite, { id: 2, shopKey: "shop-b" });
  insertListing(sqlite, { id: 3, shopKey: "shop-c" });
  splitIntoSeparateEntities(sqlite, [1, 2, 3]);

  const result = await repairDirtyExactIdentities(db);

  assert.equal(result.repairedIdentities, 1);
  const keys = sqlite
    .prepare(`
      SELECT DISTINCT e.entity_key AS key
      FROM product_search_entity_offers o
      JOIN product_search_entities e ON e.id = o.entity_id
    `)
    .all() as { key: string }[];
  assert.deepEqual(
    keys.map((row) => row.key),
    ["l-1"],
    "all three shops should end up on the representative's entity",
  );
});

test("a member already at its expected key is left out of the take-apart resync", async () => {
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1, shopKey: "shop-a", categoryId: "amplifier" });
  insertListing(sqlite, { id: 2, shopKey: "shop-b", categoryId: "amplifier" });
  insertListing(sqlite, { id: 3, shopKey: "shop-c", categoryId: "amplifier" });
  splitIntoSeparateEntities(sqlite, [1, 2, 3]);
  await repairDirtyExactIdentities(db);

  // Listing 3 acquires a conflicting category, so the group must come apart. Listing 1 is already at
  // `l-1`, which is what it should have on its own, so it needs no seed.
  sqlite.prepare("UPDATE products SET primary_category_id = 'speaker' WHERE id = 3").run();
  const result = await repairDirtyExactIdentities(db);

  assert.equal(result.repairedIdentities, 1);
  const memberships = sqlite
    .prepare(`
      SELECT o.listing_product_id AS listing, e.entity_key AS key
      FROM product_search_entity_offers o
      JOIN product_search_entities e ON e.id = o.entity_id
      ORDER BY o.listing_product_id
    `)
    .all() as { listing: number; key: string }[];
  assert.deepEqual(
    memberships.map((row) => `${row.listing}:${row.key}`),
    ["1:l-1", "2:l-2", "3:l-3"],
  );
});

test("a groupable identity is resynced once, however many shops it spans", async () => {
  // Peer expansion reaches every member of a groupable group across every shop, so the first seed
  // already converges the identity. Any further seed only recomputes the same union, which would
  // leave the repair cost proportional to the number of drifted shops.
  const { sqlite, db } = migratedSqlite();
  insertListing(sqlite, { id: 1, shopKey: "shop-a" });
  insertListing(sqlite, { id: 2, shopKey: "shop-b" });
  insertListing(sqlite, { id: 3, shopKey: "shop-c" });
  splitIntoSeparateEntities(sqlite, [1, 2, 3]);
  const recording = recordingDatabase(db);

  await repairDirtyExactIdentities(recording.db);

  // One statement per `syncProductSearchEntities` call resolves that call's own seeds.
  const seedResolutions = recording.executed.filter((statement) =>
    /SELECT id FROM products WHERE shop_key = \? AND source_id IN/u.test(statement.sql),
  );
  assert.equal(seedResolutions.length, 1, "three drifted shops must still cost one resync");

  const keys = sqlite
    .prepare(`
      SELECT DISTINCT e.entity_key AS key
      FROM product_search_entity_offers o
      JOIN product_search_entities e ON e.id = o.entity_id
    `)
    .all() as { key: string }[];
  assert.deepEqual(
    keys.map((row) => row.key),
    ["l-1"],
  );
});
