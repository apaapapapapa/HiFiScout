import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { repairActiveListingProjectionGaps } from "../src/db/product-search-gap-repair.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const NOW = "2026-08-30T12:00:00.000Z";

function insertActiveListing(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  sourceId: string,
): number {
  sqlite
    .prepare(`
      INSERT INTO products(
        shop_key, source_id, manufacturer, model, title, category, condition_text,
        price_yen, stock_status, source_url, first_seen_at, last_seen_at, last_changed_at,
        last_activity_at, is_active, raw_manufacturer, manufacturer_id,
        canonical_manufacturer_id, manufacturer_resolution_status,
        manufacturer_resolution_method, manufacturer_resolution_confidence,
        raw_model, normalized_model, model_resolution_status, model_resolution_method,
        model_resolution_confidence, raw_category, primary_category_id, category_ids,
        classification_status, search_aliases
      ) VALUES (
        'audiounion', ?, 'Example Audio', 'MODEL-1', ?, 'DAC', '中古',
        100000, 'in_stock', ?, ?, ?, ?, ?, 1,
        'Example Audio', 'example-audio', 'example-audio', 'resolved', 'verified_alias', 'high',
        'MODEL-1', 'MODEL1', 'resolved', 'seller_model', 'high', 'DAC', 'dac', '["dac"]',
        'classified', 'DAC'
      )
    `)
    .run(
      sourceId,
      `Example Audio MODEL-1 ${sourceId}`,
      `https://example.test/${sourceId}`,
      NOW,
      NOW,
      NOW,
      NOW,
    );
  return Number(
    sqlite.prepare("SELECT id FROM products WHERE source_id = ?").get(sourceId)?.id || 0,
  );
}

function poisonIdentityWrites(db: QueryableDatabase, poisonListingId: number): QueryableDatabase {
  return {
    prepare: db.prepare.bind(db),
    async batch(statements) {
      const containsPoisonIdentityWrite = statements.some((statement) => {
        const inspectable = statement as unknown as { sql?: string; binds?: unknown[] };
        return (
          inspectable.sql?.includes("INSERT INTO product_identity_resolutions") === true &&
          Number(inspectable.binds?.[0]) === poisonListingId
        );
      });
      if (containsPoisonIdentityWrite) throw new Error("synthetic poison identity write");
      return db.batch(statements);
    },
  };
}

// Reject the old all-in-one selector so this test guards the original production D1 CPU failure.
function rejectCombinedGapSelector(db: QueryableDatabase): QueryableDatabase {
  return {
    prepare(sql: string) {
      if (
        sql.includes("p.id > ?") &&
        sql.includes("current_membership") &&
        sql.includes("product_identity_resolutions r")
      ) {
        throw new Error("synthetic expensive combined gap selector");
      }
      return db.prepare(sql);
    },
    batch(statements) {
      return db.batch(statements);
    },
  } as QueryableDatabase;
}

// #437 separated cursors but still combined stale fallback detection with exact-identity peer scans.
function rejectCombinedStaleAndExactIdentitySelector(db: QueryableDatabase): QueryableDatabase {
  return {
    prepare(sql: string) {
      if (
        sql.includes("p.id > ?") &&
        sql.includes("representative_r") &&
        sql.includes("current_membership")
      ) {
        throw new Error("synthetic stale fallback selector CPU exhaustion");
      }
      return db.prepare(sql);
    },
    batch(statements) {
      return db.batch(statements);
    },
  } as QueryableDatabase;
}

function recordDerivedSelectorCursors(db: QueryableDatabase): {
  db: QueryableDatabase;
  afterIds: number[];
} {
  const afterIds: number[] = [];
  return {
    afterIds,
    db: {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.includes("p.id > ?") || !sql.includes("current_membership")) {
          return statement;
        }
        return {
          bind(...values: unknown[]) {
            afterIds.push(Number(values[0]));
            return statement.bind(...values);
          },
        } as ReturnType<QueryableDatabase["prepare"]>;
      },
      batch(statements) {
        return db.batch(statements);
      },
    } as QueryableDatabase,
  };
}

function forceGapSelectorRows(
  db: QueryableDatabase,
  staleListingIds: readonly number[],
  exactIdentityListingIds: readonly number[],
): QueryableDatabase {
  const selector = (ids: readonly number[]) => {
    const idList = ids.length ? ids.map((id) => Number(id)).join(",") : "NULL";
    return db.prepare(`
      SELECT id, shop_key, source_id
      FROM products
      WHERE id > ? AND id IN (${idList})
      ORDER BY id
      LIMIT ?
    `);
  };

  return {
    prepare(sql: string) {
      if (!sql.includes("p.id > ?")) return db.prepare(sql);
      if (sql.includes("representative_r") && !sql.includes("current_membership")) {
        return selector(staleListingIds);
      }
      if (sql.includes("current_membership")) {
        return selector(exactIdentityListingIds);
      }
      return db.prepare(sql);
    },
    batch(statements) {
      return db.batch(statements);
    },
  } as QueryableDatabase;
}

test("bounded repair isolates a poison listing instead of starving later gaps", async () => {
  const { sqlite, db } = migratedSqlite();
  const firstId = insertActiveListing(sqlite, "healthy-before");
  const poisonId = insertActiveListing(sqlite, "poison");
  const laterId = insertActiveListing(sqlite, "healthy-after");
  const resilientDb = poisonIdentityWrites(db, poisonId);

  const result = await repairActiveListingProjectionGaps(resilientDb, {
    evaluatedAt: NOW,
    batchSize: 3,
    maxListings: 3,
  });

  assert.deepEqual(result, {
    selectedCount: 3,
    repairedCount: 2,
    failedCount: 1,
    remainingGapCount: null,
  });
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_identity_resolutions WHERE listing_product_id IN (?, ?)",
      )
      .get(firstId, laterId)?.count,
    2,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_identity_resolutions WHERE listing_product_id = ?",
      )
      .get(poisonId)?.count,
    0,
  );
});

test("critical coverage gaps are selected before expensive exact-identity drift", async () => {
  const { sqlite, db } = migratedSqlite();
  const listingId = insertActiveListing(sqlite, "critical-coverage");
  const selectorGuardDb = rejectCombinedGapSelector(db);

  const result = await repairActiveListingProjectionGaps(selectorGuardDb, {
    evaluatedAt: NOW,
    batchSize: 1,
    maxListings: 1,
  });

  assert.deepEqual(result, {
    selectedCount: 1,
    repairedCount: 1,
    remainingGapCount: null,
  });
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_identity_resolutions WHERE listing_product_id = ?",
      )
      .get(listingId)?.count,
    1,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM product_search_entity_offers WHERE listing_product_id = ?",
      )
      .get(listingId)?.count,
    1,
  );
});

test("stale fallback selection does not evaluate exact-identity peer drift", async () => {
  const { sqlite, db } = migratedSqlite();
  insertActiveListing(sqlite, "selector-cpu-guard");

  await repairActiveListingProjectionGaps(db, {
    evaluatedAt: NOW,
    batchSize: 1,
    maxListings: 1,
  });

  const selectorGuardDb = rejectCombinedStaleAndExactIdentitySelector(db);
  const result = await repairActiveListingProjectionGaps(selectorGuardDb, {
    evaluatedAt: NOW,
    batchSize: 1,
    maxListings: 1,
  });

  assert.deepEqual(result, {
    selectedCount: 0,
    repairedCount: 0,
    remainingGapCount: null,
  });
});

test("derived gap scan restarts from zero after repairing a higher-id critical gap", async () => {
  const { sqlite, db } = migratedSqlite();
  const lowerId = insertActiveListing(sqlite, "lower-derived-candidate");

  await repairActiveListingProjectionGaps(db, {
    evaluatedAt: NOW,
    batchSize: 1,
    maxListings: 1,
  });

  const higherId = insertActiveListing(sqlite, "higher-critical-gap");
  assert.ok(higherId > lowerId);

  const recorded = recordDerivedSelectorCursors(db);
  await repairActiveListingProjectionGaps(recorded.db, {
    evaluatedAt: NOW,
    batchSize: 1,
    maxListings: 2,
  });

  assert.ok(recorded.afterIds.length > 0, "expected the derived gap selector to run");
  assert.equal(
    recorded.afterIds[0],
    0,
    "derived gaps below a repaired critical id must remain eligible in the same bounded sweep",
  );
});

test("a poison listing is attempted only once when stale and exact-identity phases overlap", async () => {
  const { sqlite, db } = migratedSqlite();
  const poisonId = insertActiveListing(sqlite, "cross-phase-poison");
  const healthyId = insertActiveListing(sqlite, "cross-phase-healthy");

  await repairActiveListingProjectionGaps(db, {
    evaluatedAt: NOW,
    batchSize: 2,
    maxListings: 2,
  });

  const poisonDb = poisonIdentityWrites(db, poisonId);
  const overlappingDb = forceGapSelectorRows(poisonDb, [poisonId], [poisonId, healthyId]);
  const result = await repairActiveListingProjectionGaps(overlappingDb, {
    evaluatedAt: NOW,
    batchSize: 2,
    maxListings: 2,
  });

  assert.deepEqual(result, {
    selectedCount: 2,
    repairedCount: 1,
    failedCount: 1,
    remainingGapCount: null,
  });
});

test("authoritative counted repair remains fail-fast for a poison listing", async () => {
  const { sqlite, db } = migratedSqlite();
  const poisonId = insertActiveListing(sqlite, "strict-poison");
  const poisonDb = poisonIdentityWrites(db, poisonId);

  await assert.rejects(
    repairActiveListingProjectionGaps(poisonDb, {
      evaluatedAt: NOW,
      batchSize: 1,
      maxListings: 1,
      countRemainingGaps: true,
    }),
    /synthetic poison identity write/,
  );
});