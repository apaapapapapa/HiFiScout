import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import { runRetentionCleanup } from "../src/maintenance.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  queryPlan,
  readsThroughIndex,
  recordingDatabase,
  selects,
  unindexedScans,
} from "./helpers/query-plan.js";

/**
 * What retiring an aged-out listing costs the search read model.
 *
 * A listing leaving can empty the entity it was the last offer for, so retention has to retire
 * those. It used to find them with a `NOT EXISTS` delete over the whole of
 * `product_search_entities` -- every entity read on every run, to find a set that is almost always
 * empty, because a listing is normally unlinked when it is deactivated rather than when its row is
 * finally deleted a year later.
 *
 * The sweep is now scoped to the entities the deleted listings actually belonged to. These tests
 * pin both halves: that the orphan is still retired, and that an entity nothing touched is never
 * read to decide it.
 */

const NOW = new Date("2026-08-11T00:00:00.000Z");
/** Comfortably past the 365-day inactive-listing horizon. */
const LONG_AGO = "2024-01-01T00:00:00.000Z";

function fixture() {
  const migrated = migratedSqlite();
  // The cascade from `products` is what empties a membership, so it has to be enforced here.
  migrated.sqlite.exec("PRAGMA foreign_keys = ON;");
  migrated.sqlite.exec(`
    INSERT INTO knowledge_catalog_manufacturers (id, canonical_name, created_at, updated_at)
    VALUES ('luxman', 'Luxman', datetime('now'), datetime('now'));
  `);
  return migrated;
}

/**
 * A catalog entity, which is the kind the sweep exists for.
 *
 * An `unresolved_listing` entity points at its listing through `fallback_listing_id`, which is
 * itself `ON DELETE CASCADE`, so deleting the listing takes that entity with it and the sweep never
 * sees it. A catalog entity outlives every listing that offers it, so losing the last one is what
 * leaves a row with nothing behind it.
 */
function catalogEntity(sqlite: DatabaseSync, entityKey: string): number {
  const existing = sqlite
    .prepare("SELECT id FROM product_search_entities WHERE entity_key = ?")
    .get(entityKey) as { id: number } | undefined;
  if (existing) return Number(existing.id);
  const catalogProductId = Number(
    sqlite
      .prepare(`
        INSERT INTO knowledge_catalog_products
          (manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at)
        VALUES ('luxman', ?, ?, ?, datetime('now'), datetime('now'))
      `)
      .run(entityKey, entityKey, entityKey).lastInsertRowid,
  );
  return Number(
    sqlite
      .prepare(`
        INSERT INTO product_search_entities (entity_key, entity_kind, catalog_product_id)
        VALUES (?, 'catalog', ?)
      `)
      .run(entityKey, catalogProductId).lastInsertRowid,
  );
}

/** A listing, its entity, and the membership joining them. */
function listingWithEntity(
  sqlite: DatabaseSync,
  {
    sourceId,
    entityKey,
    lastSeenAt,
    isActive = 0,
  }: {
    sourceId: string;
    entityKey: string;
    lastSeenAt: string;
    isActive?: 0 | 1;
  },
): { listingId: number; entityId: number } {
  const listingId = Number(
    sqlite
      .prepare(`
        INSERT INTO products
          (shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
        VALUES ('shop', ?, 'Luxman L-507', 'https://example.test/' || ?, ?, ?, ?, ?)
      `)
      .run(sourceId, sourceId, lastSeenAt, lastSeenAt, lastSeenAt, isActive).lastInsertRowid,
  );
  const entityId = catalogEntity(sqlite, entityKey);
  sqlite
    .prepare(`
      INSERT INTO product_search_entity_offers (listing_product_id, entity_id, shop_key)
      VALUES (?, ?, 'shop')
    `)
    .run(listingId, entityId);
  return { listingId, entityId };
}

function entityExists(sqlite: DatabaseSync, entityId: number): boolean {
  return (
    sqlite.prepare("SELECT 1 AS found FROM product_search_entities WHERE id = ?").get(entityId) !==
    undefined
  );
}

test("an aged-out listing takes the entity it was the last offer for with it", async () => {
  const { sqlite, db } = fixture();
  const orphaned = listingWithEntity(sqlite, {
    sourceId: "aged",
    entityKey: "l-aged",
    lastSeenAt: LONG_AGO,
  });

  const result = await runRetentionCleanup({ DB: db }, { now: NOW });

  assert.equal(result.deleted.inactiveProducts, 1);
  assert.equal(result.deleted.emptySearchEntities, 1);
  assert.equal(entityExists(sqlite, orphaned.entityId), false, "the emptied entity is retired");
});

test("an entity keeping another offer survives the listing that left", async () => {
  const { sqlite, db } = fixture();
  // Two listings, one entity. Only the aged-out one is deleted, so the entity still has an offer.
  const shared = listingWithEntity(sqlite, {
    sourceId: "aged-shared",
    entityKey: "l-shared",
    lastSeenAt: LONG_AGO,
  });
  listingWithEntity(sqlite, {
    sourceId: "live-shared",
    entityKey: "l-shared",
    lastSeenAt: NOW.toISOString(),
    isActive: 1,
  });

  const result = await runRetentionCleanup({ DB: db }, { now: NOW });

  assert.equal(result.deleted.inactiveProducts, 1);
  assert.equal(result.deleted.emptySearchEntities, 0, "a populated entity is not retired");
  assert.equal(entityExists(sqlite, shared.entityId), true);
});

test("an offer re-added after the candidate read keeps its entity", async () => {
  // `NOT EXISTS` is evaluated when the sweep writes, not when the candidate set is read, so a
  // membership that arrives in between still saves the entity. Reproduced by adding the offer from
  // inside the candidate read, which is the only moment the race has.
  const { sqlite, db } = fixture();
  const rescued = listingWithEntity(sqlite, {
    sourceId: "aged-rescued",
    entityKey: "l-rescued",
    lastSeenAt: LONG_AGO,
  });
  const replacement = Number(
    sqlite
      .prepare(`
        INSERT INTO products
          (shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
        VALUES ('shop', 'replacement', 'Luxman L-507', 'https://example.test/replacement',
                ?, ?, ?, 1)
      `)
      .run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString()).lastInsertRowid,
  );

  let raced = false;
  const racing = new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") return Reflect.get(target, property);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/SELECT DISTINCT entity_id/.test(sql)) return statement;
        return new Proxy(statement, {
          get(inner, key) {
            if (key !== "bind") return Reflect.get(inner, key);
            return (...binds: unknown[]) => {
              const bound = inner.bind(...(binds as never[]));
              return new Proxy(bound, {
                get(boundInner, boundKey) {
                  if (boundKey !== "all") return Reflect.get(boundInner, boundKey);
                  return async () => {
                    const answer = await boundInner.all();
                    if (!raced) {
                      raced = true;
                      sqlite
                        .prepare(`
                          INSERT INTO product_search_entity_offers
                            (listing_product_id, entity_id, shop_key)
                          VALUES (?, ?, 'shop')
                        `)
                        .run(replacement, rescued.entityId);
                    }
                    return answer;
                  };
                },
              });
            };
          },
        });
      };
    },
  });

  const result = await runRetentionCleanup({ DB: racing }, { now: NOW });

  assert.ok(raced, "the candidate read ran, so the race was actually exercised");
  assert.equal(result.deleted.inactiveProducts, 1, "the aged listing is still deleted");
  assert.equal(result.deleted.emptySearchEntities, 0);
  assert.equal(
    entityExists(sqlite, rescued.entityId),
    true,
    "an entity that gained an offer is not retired for having been empty when read",
  );
});

test("a run with nothing to age out never reads the entity table", async () => {
  // The cost this change exists for. With no listing old enough to delete there is no candidate
  // set, so the sweep does not run at all -- rather than reading every entity to find none.
  const { sqlite, db } = fixture();
  listingWithEntity(sqlite, {
    sourceId: "live",
    entityKey: "l-live",
    lastSeenAt: NOW.toISOString(),
    isActive: 1,
  });
  const recording = recordingDatabase(db);

  const result = await runRetentionCleanup({ DB: recording.db }, { now: NOW });

  assert.equal(result.deleted.inactiveProducts, 0);
  assert.equal(result.deleted.emptySearchEntities, 0);
  const touching = recording.executed.filter((statement) =>
    /product_search_entit/.test(statement.sql),
  );
  assert.deepEqual(
    touching.map((statement) => statement.sql.trim().split("\n")[0]),
    [],
    "no statement reads or writes the search entity tables when nothing aged out",
  );
});

test("the sweep seeks the entities it was given and never scans the table", async () => {
  const { sqlite, db } = fixture();
  listingWithEntity(sqlite, {
    sourceId: "aged-plan",
    entityKey: "l-aged-plan",
    lastSeenAt: LONG_AGO,
  });
  // Entities nothing touched. The old sweep read all of these; the scoped one must not.
  for (let index = 0; index < 25; index += 1) {
    listingWithEntity(sqlite, {
      sourceId: `bystander-${index}`,
      entityKey: `l-bystander-${index}`,
      lastSeenAt: NOW.toISOString(),
      isActive: 1,
    });
  }
  const recording = recordingDatabase(db);

  await runRetentionCleanup({ DB: recording.db }, { now: NOW });

  const sweep = recording.executed.find((statement) =>
    /DELETE FROM product_search_entities/.test(statement.sql),
  );
  assert.ok(sweep, "the sweep ran");
  const plan = queryPlan(sqlite, sweep);
  assert.deepEqual(
    unindexedScans(plan),
    [],
    `the sweep must not read a table end to end:\n${plan.map((step) => step.detail).join("\n")}`,
  );
  assert.ok(
    readsThroughIndex(plan, "m", "idx_product_search_entity_offers_entity"),
    `the membership probe must seek:\n${plan.map((step) => step.detail).join("\n")}`,
  );

  // And the candidate read that feeds it is bounded the same way.
  const candidates = selects(recording.executed).find((statement) =>
    /SELECT DISTINCT entity_id/.test(statement.sql),
  );
  assert.ok(candidates);
  assert.deepEqual(unindexedScans(queryPlan(sqlite, candidates)), []);
});

test("a run past one chunk retires every orphan and counts each half once", async () => {
  // The scope fragments are chunked, so the counts come from slicing one batch's results into the
  // listing half and the entity half. Off-by-one there would be invisible with a single chunk.
  const { sqlite, db } = fixture();
  const entityIds: number[] = [];
  for (let index = 0; index < 45; index += 1) {
    entityIds.push(
      listingWithEntity(sqlite, {
        sourceId: `aged-${index}`,
        entityKey: `c-aged-${index}`,
        lastSeenAt: LONG_AGO,
      }).entityId,
    );
  }

  const result = await runRetentionCleanup({ DB: db }, { now: NOW });

  assert.equal(result.deleted.inactiveProducts, 45, "every aged listing is deleted once");
  assert.equal(result.deleted.emptySearchEntities, 45, "and every emptied entity is retired once");
  assert.deepEqual(
    entityIds.filter((id) => entityExists(sqlite, id)),
    [],
    "no orphan survives past the first chunk",
  );
});

/**
 * The residue the scoped sweep cannot reach.
 *
 * Bounding the daily sweep answers for orphans this path creates from now on. It cannot answer for
 * ones already in the table: the earlier implementation deleted listings and swept entities as two
 * separate statements, so an interrupted run committed the cascade and lost the sweep, and by then
 * both the listing and the membership are gone -- there is nothing left to derive a candidate from.
 * Migration 0121 clears those once, which is why the daily path is allowed to stop looking.
 */
const ORPHAN_MIGRATION = readFileSync(
  new URL("../migrations/0121_retire_pre_existing_orphan_entities.sql", import.meta.url),
  "utf8",
);

test("migration 0121 clears the orphans the scoped sweep can no longer find", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE product_search_entities (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_key TEXT NOT NULL UNIQUE);
    CREATE TABLE product_search_entity_offers (
      listing_product_id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES product_search_entities(id) ON DELETE CASCADE
    );
    INSERT INTO product_search_entities(id, entity_key) VALUES (1, 'c-orphan'), (2, 'c-offered');
    INSERT INTO product_search_entity_offers(listing_product_id, entity_id) VALUES (10, 2);
  `);

  sqlite.exec(ORPHAN_MIGRATION);

  assert.deepEqual(
    (
      sqlite.prepare("SELECT entity_key FROM product_search_entities ORDER BY id").all() as {
        entity_key: string;
      }[]
    ).map((row) => row.entity_key),
    ["c-offered"],
    "the orphan is cleared and the entity with an offer is left alone",
  );
});
