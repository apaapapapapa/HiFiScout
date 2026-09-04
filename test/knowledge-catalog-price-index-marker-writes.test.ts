import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";

import { migratedSqlite } from "./helpers/migrated-sqlite.js";

/**
 * What an asking sample costs to record.
 *
 * The recent-expiry marker stores the earliest time at which a product's recent-asking window can
 * change through the passage of time alone. Asking evidence is append-only and arrives roughly in
 * observation order, so the common insert observes something *newer* than the marker already
 * accounts for: its own 90-day expiry falls later than the stored one, and the stored value is
 * correctly kept.
 *
 * Keeping it used to rewrite the row anyway -- the conflict clause chose the older value with a
 * `CASE` and then assigned `updated_at` regardless. D1 bills rows written, so that was a physical
 * write per asking insert for a marker that had not moved. The condition now lives on the conflict
 * clause instead of in the assignment, so the upsert writes only when the expiry actually moves
 * earlier.
 */

const CATALOG_PRODUCT_ID = 9001;

/**
 * Observation times are derived from SQLite's own clock, not written as literals.
 *
 * The trigger compares against `now`: a sample only records an expiry while it is inside the
 * 90-day recent window, and the expiry it records is its own observation plus 90 days. Fixed dates
 * therefore stop meaning what the test says they mean as wall-clock time advances -- an observation
 * chosen to sit inside the window drifts out of it, and the test starts failing on a date rather
 * than on a change. Offsets keep every relationship true whenever the suite runs.
 */
function at(sqlite: DatabaseSync, modifier: string): string {
  return (
    sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AS at").get(modifier) as {
      at: string;
    }
  ).at;
}

interface Marker {
  next_expiry_at: string | null;
  updated_at: string;
}

function priceIndexFixture() {
  const database = migratedSqlite();
  database.sqlite.exec(`
    DELETE FROM knowledge_catalog_price_index_samples;
    DELETE FROM knowledge_catalog_price_index_recent_refreshes;
    DELETE FROM knowledge_catalog_price_indexes;
    DELETE FROM knowledge_catalog_products;
    INSERT INTO products
      (shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at, is_active)
    VALUES ('shop', 'src-1', 'Listing', 'https://example.test/1',
            datetime('now'), datetime('now'), datetime('now'), 1);
    INSERT INTO knowledge_catalog_manufacturers (id, canonical_name, created_at, updated_at)
    VALUES ('luxman', 'Luxman', datetime('now'), datetime('now'));
    INSERT INTO knowledge_catalog_products
      (id, manufacturer_id, canonical_model, normalized_model, canonical_name, created_at, updated_at)
    VALUES (${CATALOG_PRODUCT_ID}, 'luxman', 'L-507', 'l507', 'Luxman L-507',
            datetime('now'), datetime('now'));
  `);
  return database;
}

let eventId = 0;

function insertAskingSample(sqlite: DatabaseSync, priceYen: number, observedAt: string): void {
  eventId += 1;
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_price_index_samples(
        event_key, catalog_product_id, listing_product_id, shop_key, source_id,
        sample_kind, signal_kind, price_yen, observed_at
      ) VALUES (?, ?, (SELECT id FROM products LIMIT 1), 'shop', ?, 'asking', 'asking', ?, ?)
    `)
    .run(`marker-${eventId}`, CATALOG_PRODUCT_ID, `source-${eventId}`, priceYen, observedAt);
}

function marker(sqlite: DatabaseSync): Marker | undefined {
  return sqlite
    .prepare(`
      SELECT next_expiry_at, updated_at
      FROM knowledge_catalog_price_index_recent_refreshes
      WHERE catalog_product_id = ?
    `)
    .get(CATALOG_PRODUCT_ID) as Marker | undefined;
}

/**
 * Physical row changes -- whether a row was written at all, which is what these tests are about.
 *
 * Not the billed figure. D1's `rows_written` also charges an index entry per index the write
 * maintains, and `total_changes()` cannot see those: the marker table carries
 * `idx_price_index_recent_refresh_due` and the sample ledger four indexes, so a marker write bills 2
 * and a sample insert 5. The counts below are therefore lower bounds on what is saved, and the
 * saving they prove is if anything larger than the number shown. What makes them the right
 * instrument here is that they answer the only question the change turns on -- did the upsert touch
 * the row, or not.
 */
function totalChanges(sqlite: DatabaseSync): number {
  return Number((sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
}

test("an asking sample that cannot move the expiry does not rewrite the marker", async () => {
  const { sqlite } = priceIndexFixture();
  insertAskingSample(sqlite, 250_000, at(sqlite, "-30 days"));
  const stored = marker(sqlite);
  assert.ok(stored?.next_expiry_at, "the first asking sample establishes the marker");

  const before = totalChanges(sqlite);
  // Observed later than the marker accounts for, so its own expiry falls later and the stored
  // value stands. This is the common shape: asking evidence is append-only.
  insertAskingSample(sqlite, 249_000, at(sqlite, "-1 day"));
  const changed = totalChanges(sqlite) - before;
  const after = marker(sqlite);

  assert.equal(after?.next_expiry_at, stored.next_expiry_at, "the earliest expiry is unchanged");
  assert.equal(after?.updated_at, stored.updated_at, "and so is the row: nothing was written");
  assert.equal(
    changed,
    2,
    `only the sample and its aggregate should be written, not the marker: ${changed} rows`,
  );
});

test("an asking sample that does move the expiry earlier still updates the marker", async () => {
  const { sqlite } = priceIndexFixture();
  insertAskingSample(sqlite, 250_000, at(sqlite, "-30 days"));
  const stored = marker(sqlite);
  assert.ok(stored?.next_expiry_at);

  const before = totalChanges(sqlite);
  insertAskingSample(sqlite, 249_000, at(sqlite, "-80 days"));
  const changed = totalChanges(sqlite) - before;
  const after = marker(sqlite);

  assert.ok(
    (after?.next_expiry_at ?? "") < stored.next_expiry_at,
    `the earlier observation expires first: ${after?.next_expiry_at} vs ${stored.next_expiry_at}`,
  );
  // Deliberately not asserted on `updated_at`: both writes take it from `now`, and two statements
  // inside the same millisecond produce the same string. The moved expiry and the row-change count
  // are what prove the update happened.
  assert.equal(changed, 3, "sample, aggregate and marker");
});

test("the first asking sample for a product establishes a marker", async () => {
  const { sqlite } = priceIndexFixture();
  assert.equal(marker(sqlite), undefined);
  const observedAt = at(sqlite, "-30 days");

  insertAskingSample(sqlite, 250_000, observedAt);

  const created = marker(sqlite);
  assert.ok(created?.next_expiry_at, "an absent marker is inserted, not skipped by the condition");
  const expected = (
    sqlite
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+90 days') AS at")
      .get(observedAt) as { at: string }
  ).at;
  assert.equal(created.next_expiry_at, expected, "90 days after the observation");
});

test("a sample older than the recent window leaves the marker alone", async () => {
  // Outside 90 days it cannot contribute to the recent median, so it has no expiry to record.
  const { sqlite } = priceIndexFixture();
  insertAskingSample(sqlite, 250_000, at(sqlite, "-30 days"));
  const stored = marker(sqlite);
  assert.ok(stored);

  const before = totalChanges(sqlite);
  insertAskingSample(sqlite, 249_000, at(sqlite, "-200 days"));
  const changed = totalChanges(sqlite) - before;

  assert.deepEqual(marker(sqlite), stored);
  assert.equal(changed, 2, "the marker is untouched by evidence it does not cover");
});

test("repeated appends cost one marker write, not one per sample", async () => {
  // The amplification this removes, end to end: ten appends in observation order write the marker
  // once -- when it is first established -- and never again.
  const { sqlite } = priceIndexFixture();
  const before = totalChanges(sqlite);

  // Ten observations in order, each newer than the last and all inside the recent window, so only
  // the first can establish an expiry and none of the rest can move it earlier.
  const observations = Array.from({ length: 10 }, (_, index) => at(sqlite, `-${40 - index} days`));
  sqlite.exec("BEGIN");
  for (const [index, observedAt] of observations.entries()) {
    insertAskingSample(sqlite, 250_000 - index, observedAt);
  }
  sqlite.exec("COMMIT");

  const changed = totalChanges(sqlite) - before;
  // 10 samples + 10 aggregate rewrites + 1 marker insert. The aggregate rewrites are the separate
  // recompute amplification; what is asserted here is that the marker contributes exactly one.
  assert.equal(changed, 21, `expected one marker write across ten appends: ${changed} rows`);
  const earliest = (
    sqlite
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+90 days') AS at")
      .get(observations[0]!) as { at: string }
  ).at;
  assert.equal(marker(sqlite)?.next_expiry_at, earliest, "the earliest of the ten");
});
