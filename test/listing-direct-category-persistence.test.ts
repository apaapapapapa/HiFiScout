import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import type { CatalogNormalizationInput } from "../src/catalog/types.js";
import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import { updateListingAdminProduct } from "../src/db/listing-admin-repository.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const OBSERVED_AT = "2026-08-26T00:00:00.000Z";

function listing(overrides: Partial<CatalogNormalizationInput> & { sourceId: string }) {
  return normalizeCatalogProduct({
    manufacturer: "",
    model: "",
    title: "",
    conditionText: "中古",
    priceYen: 100000,
    stockStatus: "in_stock",
    sourceUrl: `https://example.test/${overrides.sourceId}`,
    ...overrides,
  });
}

interface MembershipRow {
  category_id: string;
  is_direct: number;
}

function membership(sqlite: ReturnType<typeof migratedSqlite>["sqlite"], sourceId: string) {
  const rows = sqlite
    .prepare(`
      SELECT pc.category_id, pc.is_direct
      FROM product_categories pc
      JOIN products p ON p.id = pc.product_id
      WHERE p.source_id = ?
      ORDER BY pc.category_id
    `)
    .all(sourceId) as unknown as MembershipRow[];
  // node:sqlite returns null-prototype rows, which `deepEqual` refuses to match against literals.
  return rows.map((row) => ({ category_id: row.category_id, is_direct: row.is_direct }));
}

function storedDirectIds(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  sourceId: string,
): string[] {
  const row = sqlite
    .prepare("SELECT direct_category_ids FROM products WHERE source_id = ?")
    .get(sourceId) as { direct_category_ids: string } | undefined;
  return JSON.parse(String(row?.direct_category_ids)) as string[];
}

test("a set listing records both component categories in its direct set", async () => {
  const { sqlite, db } = migratedSqlite();
  await upsertProducts(
    db,
    "hifido",
    [
      listing({
        sourceId: "set-1",
        manufacturer: "ESOTERIC",
        model: "Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
        title: "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
      }),
    ],
    OBSERVED_AT,
  );

  assert.deepEqual(storedDirectIds(sqlite, "set-1"), ["dac", "transport"]);
});

test("a set listing is a member of both component categories and the parent they share", async () => {
  const { sqlite, db } = migratedSqlite();
  await upsertProducts(
    db,
    "hifido",
    [
      listing({
        sourceId: "set-2",
        manufacturer: "ESOTERIC",
        model: "Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
        title: "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
      }),
    ],
    OBSERVED_AT,
  );

  assert.deepEqual(membership(sqlite, "set-2"), [
    { category_id: "dac", is_direct: 1 },
    { category_id: "digital", is_direct: 0 },
    { category_id: "transport", is_direct: 1 },
  ]);
});

test("the parent two components share is one membership row, not one per component", async () => {
  const { sqlite, db } = migratedSqlite();
  await upsertProducts(
    db,
    "hifido",
    [
      listing({
        sourceId: "set-3",
        manufacturer: "ESOTERIC",
        model: "K-01XD SACDプレーヤー + N-05XD ネットワークプレーヤー",
        title: "ESOTERIC K-01XD SACDプレーヤー + N-05XD ネットワークプレーヤー",
      }),
    ],
    OBSERVED_AT,
  );

  const rows = membership(sqlite, "set-3");
  assert.equal(rows.filter((row) => row.category_id === "digital").length, 1);
  assert.equal(rows.filter((row) => row.is_direct === 1).length, 2);
});

test("a single-product listing keeps exactly the membership it had before", async () => {
  const { sqlite, db } = migratedSqlite();
  await upsertProducts(
    db,
    "hifido",
    [
      listing({
        sourceId: "single-1",
        manufacturer: "Marantz",
        model: "PM-14S1",
        title: "Marantz PM-14S1 プリメインアンプ",
      }),
    ],
    OBSERVED_AT,
  );

  assert.deepEqual(storedDirectIds(sqlite, "single-1"), ["integrated_amp"]);
  assert.deepEqual(membership(sqlite, "single-1"), [
    { category_id: "amplifier", is_direct: 0 },
    { category_id: "integrated_amp", is_direct: 1 },
  ]);
});

test("re-reading an unchanged set listing is not a change", async () => {
  const { sqlite, db } = migratedSqlite();
  const product = listing({
    sourceId: "set-4",
    manufacturer: "ESOTERIC",
    model: "Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
    title: "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
  });

  await upsertProducts(db, "hifido", [product], OBSERVED_AT);
  const second = await upsertProducts(db, "hifido", [product], "2026-08-27T00:00:00.000Z");

  assert.equal(
    second.changedCount,
    0,
    "the stored direct set must round-trip, or every set listing rewrites itself on every crawl",
  );
  assert.deepEqual(storedDirectIds(sqlite, "set-4"), ["dac", "transport"]);
});

/**
 * The 0055 backfill is what makes every listing already in production correct on deploy, so it is
 * worth running rather than reading. The row is written by the normal write path and then reset to
 * the shape it had before the migration existed.
 */
test("the migration backfills a pre-existing listing from its primary category", async () => {
  const { sqlite, db } = migratedSqlite();
  await upsertProducts(
    db,
    "hifido",
    [
      listing({
        sourceId: "legacy-1",
        manufacturer: "Marantz",
        model: "PM-14S1",
        title: "Marantz PM-14S1 プリメインアンプ",
      }),
    ],
    OBSERVED_AT,
  );

  sqlite.exec("UPDATE products SET direct_category_ids = NULL");
  sqlite.exec("UPDATE product_categories SET is_direct = 0");

  const migration = readFileSync(
    new URL("../migrations/0055_listing_direct_categories.sql", import.meta.url),
    "utf8",
  );
  const backfills = migration
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.toUpperCase().startsWith("UPDATE"));
  assert.equal(backfills.length, 2, "both backfills must still be present in the migration");
  for (const statement of backfills) sqlite.exec(statement);

  assert.deepEqual(storedDirectIds(sqlite, "legacy-1"), ["integrated_amp"]);
  assert.deepEqual(membership(sqlite, "legacy-1"), [
    { category_id: "amplifier", is_direct: 0 },
    { category_id: "integrated_amp", is_direct: 1 },
  ]);
});

const SET_TITLE = "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC";

const SET_REPLAY_JOB_ROW = {
  id: 1,
  work_key: "auto:classify_category:11",
  work_type: "classify_category",
  listing_product_id: 11,
  entity_id: "11",
  reason: "stale classifier version",
  source: "auto",
  status: "processing",
  priority: 100,
  attempt_count: 1,
  max_attempts: 3,
  available_at: OBSERVED_AT,
  claimed_at: OBSERVED_AT,
  lease_expires_at: "2026-08-26T00:05:00.000Z",
  resolved_at: null,
  last_error: "",
  created_at: OBSERVED_AT,
  updated_at: OBSERVED_AT,
};

const SET_LISTING_ROW = {
  id: 11,
  shop_key: "hifido",
  source_id: "set-replay",
  manufacturer: "ESOTERIC",
  raw_manufacturer: "ESOTERIC",
  normalized_raw_manufacturer: "esoteric",
  manufacturer_id: "esoteric",
  canonical_manufacturer_id: "esoteric",
  manufacturer_resolution_status: "resolved",
  manufacturer_resolution_method: "bootstrap_alias",
  manufacturer_resolution_confidence: "high",
  manufacturer_resolver_version: 1,
  model: "Grandioso P1",
  raw_model: "Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
  normalized_model: "GRANDIOSOP1",
  presentation_color: "",
  model_resolution_status: "resolved",
  model_resolution_method: "seller_model",
  model_resolution_confidence: "medium",
  model_resolver_version: 1,
  title: SET_TITLE,
  category: "",
  raw_category: "",
  primary_category_id: "transport",
  category_ids: '["transport"]',
  direct_category_ids: '["transport"]',
  classification_status: "classified",
  search_aliases: "",
  metadata_json: "{}",
  remediation_projection_required: 0,
  remediation_projection_token: "",
};

/**
 * The crawl and the replay are two writers of the same derived fields. If only one of them knows
 * about component categories, a replay silently reverts every set listing the crawl got right.
 */
test("the data-quality replay writes the same direct set the crawl path writes", async () => {
  const db = captureDatabase((statement) => {
    const sql = statement.sql;
    if (/WHEN p\.manufacturer_resolver_version < \? THEN 'resolve_manufacturer'/.test(sql))
      return [];
    if (/FROM data_quality_remediation_queue INDEXED BY idx_dq_remediation_queue_pending/.test(sql))
      return [{ id: 1 }];
    if (/SELECT \*\s+FROM data_quality_remediation_queue\s+WHERE id IN/.test(sql))
      return [SET_REPLAY_JOB_ROW];
    if (/SELECT attempt_count, max_attempts FROM data_quality_remediation_queue/.test(sql))
      return [{ attempt_count: 1, max_attempts: 3 }];
    if (/FROM products\s+WHERE id = \?/.test(sql)) return [SET_LISTING_ROW];
    return [];
  });

  await runDataQualityRemediationSweep(db, {
    seedLimit: 10,
    claimLimit: 10,
    leaseSeconds: 300,
    now: new Date(OBSERVED_AT),
  });

  const replay = db.calls.find((call) => /UPDATE products\s+SET manufacturer = \?/.test(call.sql));
  assert.ok(replay, "a classify_category job must replay the listing's derived fields");

  const crawlDirectIds = listing({
    sourceId: "set-replay",
    manufacturer: "ESOTERIC",
    model: SET_LISTING_ROW.raw_model,
    title: SET_TITLE,
  }).directCategoryIds;

  assert.deepEqual(crawlDirectIds, ["dac", "transport"]);
  assert.equal(replay.binds[18], JSON.stringify(crawlDirectIds));
});

/**
 * An admin editing a model has said nothing about categories. Rewriting the direct set from the
 * primary there would erase a set's categories over an unrelated edit — and silently, because
 * `product_categories` is only rebuilt inside the category-override branch, so the two
 * representations would be left disagreeing.
 */
test("an admin edit that is not a category override leaves the direct set alone", async () => {
  const { sqlite, db } = migratedSqlite();
  await upsertProducts(
    db,
    "hifido",
    [
      listing({
        sourceId: "set-admin",
        manufacturer: "ESOTERIC",
        model: "Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
        title: "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
      }),
    ],
    OBSERVED_AT,
  );
  const before = storedDirectIds(sqlite, "set-admin");
  assert.deepEqual(before, ["dac", "transport"]);

  const id = (
    sqlite.prepare("SELECT id FROM products WHERE source_id = ?").get("set-admin") as
      | { id: number }
      | undefined
  )?.id;
  assert.ok(id);
  await updateListingAdminProduct(db, id, { model: "Grandioso P1 Set" }, OBSERVED_AT);

  assert.deepEqual(storedDirectIds(sqlite, "set-admin"), before);
});

test("an admin category override replaces the direct set with the one category chosen", async () => {
  const { sqlite, db } = migratedSqlite();
  await upsertProducts(
    db,
    "hifido",
    [
      listing({
        sourceId: "set-override",
        manufacturer: "ESOTERIC",
        model: "Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
        title: "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
      }),
    ],
    OBSERVED_AT,
  );
  const id = (
    sqlite.prepare("SELECT id FROM products WHERE source_id = ?").get("set-override") as
      | { id: number }
      | undefined
  )?.id;
  assert.ok(id);

  await updateListingAdminProduct(db, id, { primaryCategoryId: "dac" }, OBSERVED_AT);

  assert.deepEqual(storedDirectIds(sqlite, "set-override"), ["dac"]);
});
