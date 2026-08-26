import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { parseProductSearchKey, productSearchKey } from "../src/api/product-search-key.js";
import {
  productSearchEntityConsistency,
  rebuildProductSearchEntities,
  syncProductSearchEntities,
} from "../src/db/product-search-entity-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import type { CapturedStatement, StatementResults } from "./helpers/d1.js";

/** Answers the id lookups a sync performs, so the write statements receive a real scope. */
function syncResults({
  listingIds = [7],
  entityIds = [21],
}: {
  listingIds?: number[];
  entityIds?: number[];
} = {}): StatementResults {
  return (statement: CapturedStatement) => {
    if (/SELECT id FROM products WHERE shop_key/.test(statement.sql)) {
      return listingIds.map((id) => ({ id }));
    }
    if (/entity_id AS entity_id|id AS entity_id/.test(statement.sql)) {
      return entityIds.map((id) => ({ entity_id: id }));
    }
    return [];
  };
}

function writes(db: { calls: readonly CapturedStatement[] }): CapturedStatement[] {
  return db.calls.filter((statement) => /^\s*(INSERT|DELETE|UPDATE)/.test(statement.sql));
}

test("entity and membership transitions are committed atomically before aggregate refresh", async () => {
  const db = captureDatabase(syncResults());
  await syncProductSearchEntities(db, "hifido", ["source-1"]);

  const order = writes(db).map((statement) =>
    /INSERT INTO product_search_entities\(/.test(statement.sql)
      ? "entity"
      : /INSERT INTO product_search_entity_offers/.test(statement.sql)
        ? "membership"
        : /DELETE FROM product_search_entity_offers/.test(statement.sql)
          ? "membership-cleanup"
          : /DELETE FROM product_search_entities/.test(statement.sql)
            ? "prune"
            : "refresh",
  );

  assert.deepEqual(order, [
    "entity",
    "entity",
    "membership-cleanup",
    "membership",
    "membership",
    "membership",
    "prune",
    "prune",
    // Aggregates, finishes, category membership (upsert + stale-row sweep), direct-category
    // presentation and search terms, in that order.
    "refresh",
    "refresh",
    "refresh",
    "refresh",
    "refresh",
    "refresh",
    "prune",
  ]);
  assert.equal(db.batched.length, 8);
  assert.deepEqual(
    writes({ calls: db.batched }).map((statement) =>
      /DELETE FROM product_search_entities/.test(statement.sql) ? "prune" : "projection-write",
    ),
    [
      "projection-write",
      "projection-write",
      "projection-write",
      "projection-write",
      "projection-write",
      "projection-write",
      "prune",
      "prune",
    ],
  );
});

test("catalog grouping still requires a matched resolution against a verified product", async () => {
  const db = captureDatabase(syncResults());
  await syncProductSearchEntities(db, "hifido", ["source-1"]);

  const membership = writes(db).find((statement) =>
    /INSERT INTO product_search_entity_offers[\s\S]*JOIN product_identity_resolutions r ON/.test(
      statement.sql,
    ),
  );
  assert.ok(membership);
  assert.match(membership.sql, /r\.status = 'matched'/);
  assert.match(membership.sql, /kp\.verification_status = 'verified'/);
  assert.match(membership.sql, /p\.is_active = 1/);
  // Candidate catalog evidence and model stems must never reach either grouping decision.
  for (const statement of db.calls) {
    assert.doesNotMatch(statement.sql, /candidate_catalog_product_id/);
    assert.doesNotMatch(statement.sql, /model_stem/);
  }
});

test("an unresolved listing gets a fallback entity before any exact-peer refinement", async () => {
  const db = captureDatabase(syncResults());
  await syncProductSearchEntities(db, "hifido", ["source-1"]);

  const fallback = writes(db).find((statement) =>
    /INSERT INTO product_search_entities\([\s\S]*'unresolved_listing'/.test(statement.sql),
  );
  assert.ok(fallback);
  assert.match(fallback.sql, /NOT EXISTS/);
  assert.match(fallback.sql, /r\.status = 'matched'/);
  assert.match(fallback.sql, /'l-' \|\| p\.id/);
});

test("a newly confirmed listing is not pulled back by the fallback entity it is leaving", async () => {
  const db = captureDatabase(syncResults());
  await syncProductSearchEntities(db, "hifido", ["source-1"]);

  // The fallback entity outlives the match until the prune at the end of the pass, so the
  // fallback membership upsert has to re-check identity instead of trusting the `l-<id>` key.
  const fallbackMembership = writes(db).find(
    (statement) =>
      /INSERT INTO product_search_entity_offers/.test(statement.sql) &&
      /'l-' \|\| p\.id/.test(statement.sql),
  );
  assert.ok(fallbackMembership);
  assert.match(fallbackMembership.sql, /NOT EXISTS/);
  assert.match(fallbackMembership.sql, /r\.status = 'matched'/);
  assert.match(fallbackMembership.sql, /kp\.verification_status = 'verified'/);
});

test("a departed listing handed to the sync has its membership retired", async () => {
  // Which listings have gone is the `membership_cleanup` stage's question; it answers it in bounded
  // chunks and hands them here. This is the half that has to retire them once it does.
  const db = captureDatabase(syncResults({ listingIds: [99] }));
  const result = await syncProductSearchEntities(db, "hifido", ["source-gone"]);

  assert.equal(result.listing_count, 1);
  const cleanup = writes(db).find((statement) =>
    /DELETE FROM product_search_entity_offers/.test(statement.sql),
  );
  assert.ok(cleanup);
  assert.match(cleanup.sql, /p\.is_active = 0/);
  assert.deepEqual(cleanup.binds, [99]);
});

test("entities the listings are leaving are refreshed alongside the ones they join", async () => {
  let seen = 0;
  const db = captureDatabase((statement) => {
    if (/SELECT id FROM products WHERE shop_key/.test(statement.sql)) return [{ id: 7 }];
    if (/p\.shop_key = \? AND p\.is_active = 0/.test(statement.sql)) return [];
    if (/entity_id AS entity_id/.test(statement.sql)) {
      // The listing moves from its fallback entity to a shared catalog entity mid-sync.
      seen += 1;
      return seen === 1 ? [{ entity_id: 55 }] : [{ entity_id: 12 }];
    }
    if (/id AS entity_id/.test(statement.sql)) return [];
    return [];
  });

  await syncProductSearchEntities(db, "hifido", ["source-1"]);

  const prunes = writes(db).filter((statement) =>
    /DELETE FROM product_search_entities/.test(statement.sql),
  );
  const prune = prunes.at(-1);
  assert.ok(prune);
  assert.deepEqual([...prune.binds].sort(), [12, 55]);
  assert.match(prune.sql, /NOT EXISTS/);
});

test("a shop with nothing to sync performs no writes at all", async () => {
  const db = captureDatabase(syncResults({ listingIds: [], entityIds: [] }));
  const result = await syncProductSearchEntities(db, "hifido", []);

  assert.deepEqual(result, { listing_count: 0, entity_count: 0, removed_entity_count: 0 });
  assert.equal(writes(db).length, 0);
});

test("rebuild runs the same statements unscoped and reports the resulting totals", async () => {
  const db = captureDatabase((statement) =>
    /SELECT\s+\(SELECT COUNT\(\*\) FROM product_search_entities\)/.test(statement.sql)
      ? [{ entity_count: 120, offer_count: 180 }]
      : [],
  );

  const result = await rebuildProductSearchEntities(db);

  assert.equal(result.entity_count, 120);
  assert.equal(result.offer_count, 180);
  for (const statement of writes(db)) {
    assert.deepEqual(statement.binds, [], statement.sql);
    assert.doesNotMatch(statement.sql, /IN \(\?/);
  }
});

test("rebuild is idempotent by construction: every write converges on a unique key", async () => {
  const db = captureDatabase();
  await rebuildProductSearchEntities(db);

  const upserts = writes(db).filter((statement) => /^\s*INSERT INTO/.test(statement.sql));
  assert.equal(upserts.length, 6);
  for (const statement of upserts) {
    assert.match(
      statement.sql,
      /ON CONFLICT\((entity_key|listing_product_id|entity_id, category_id)\) DO UPDATE SET/,
    );
  }
});

test("consistency reports every invariant separately and summarises them into one signal", async () => {
  const clean = captureDatabase([
    {
      unmembered_active_listings: 0,
      inactive_offer_memberships: 0,
      entities_without_offers: 0,
      stale_fallback_entities: 0,
      ineligible_catalog_entities: 0,
      offer_count_mismatches: 0,
    },
  ]);
  assert.equal((await productSearchEntityConsistency(clean)).ok, true);

  const drifted = captureDatabase([
    {
      unmembered_active_listings: 0,
      inactive_offer_memberships: 0,
      entities_without_offers: 0,
      stale_fallback_entities: 3,
      ineligible_catalog_entities: 0,
      offer_count_mismatches: 0,
    },
  ]);
  const report = await productSearchEntityConsistency(drifted);
  assert.equal(report.ok, false);
  assert.equal(report.stale_fallback_entities, 3);
  assert.equal(report.fts_integrity_ok, true);
});

test("a failing FTS integrity check is drift, not an exception the caller has to handle", async () => {
  const db = captureDatabase();
  const prepare = db.prepare.bind(db);
  const failing = {
    ...db,
    prepare(sql: string) {
      if (/integrity-check/.test(sql)) {
        return {
          bind() {
            return {
              async run() {
                throw new Error("database disk image is malformed");
              },
            };
          },
        };
      }
      return prepare(sql);
    },
  } as typeof db;

  const report = await productSearchEntityConsistency(failing);
  assert.equal(report.fts_integrity_ok, false);
  assert.equal(report.ok, false);
});

test("entity keys namespace the two id spaces that would otherwise collide", () => {
  assert.equal(productSearchKey("catalog", 12), "c-12");
  assert.equal(productSearchKey("unresolved_listing", 12), "l-12");
  assert.deepEqual(parseProductSearchKey("c-12"), { kind: "catalog", id: 12 });
  assert.deepEqual(parseProductSearchKey("l-12"), { kind: "unresolved_listing", id: 12 });
  assert.notDeepEqual(parseProductSearchKey("c-12"), parseProductSearchKey("l-12"));
});

test("anything that is not a well-formed key is rejected rather than coerced", () => {
  for (const value of ["", "12", "c-", "c-0", "c--1", "x-12", "c-12 ", "c-12;DROP", null]) {
    assert.equal(parseProductSearchKey(value), null, String(value));
  }
});
