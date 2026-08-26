import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  CATEGORY_CLASSIFICATION_METADATA_VERSION,
  normalizeCatalogProduct,
} from "../src/catalog/product-normalizer.js";
import type { CatalogNormalizationInput } from "../src/catalog/types.js";
import { runDataQualityRemediationSweep } from "../src/db/data-quality-remediation-service.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";

const OBSERVED_AT = "2026-08-27T00:00:00.000Z";
const SHOP = "hifido";
const SET_TITLE = "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC";

function listing(overrides: Partial<CatalogNormalizationInput> & { sourceId: string }) {
  return normalizeCatalogProduct({
    manufacturer: "",
    model: "",
    title: "",
    conditionText: "中古",
    priceYen: 1_000_000,
    stockStatus: "in_stock",
    sourceUrl: `https://example.test/${overrides.sourceId}`,
    ...overrides,
  });
}

async function seedCurrentInventory(db: QueryableDatabase): Promise<void> {
  const products = [
    listing({ sourceId: "set-1", manufacturer: "ESOTERIC", model: SET_TITLE, title: SET_TITLE }),
    listing({
      sourceId: "single-1",
      manufacturer: "Marantz",
      model: "PM-14S1",
      title: "Marantz PM-14S1 プリメインアンプ",
    }),
    listing({
      sourceId: "single-2",
      manufacturer: "ESOTERIC",
      model: "K-01XD",
      title: "ESOTERIC K-01XD SACDプレーヤー",
    }),
  ];
  await upsertProducts(db, SHOP, products, OBSERVED_AT);
  await refreshListingProjections(
    db,
    products.map((product) => ({ shop_key: SHOP, source_id: product.sourceId })),
    OBSERVED_AT,
  );
}

test("category-version backfill seeds the active inventory once and drains across bounded sweeps", async () => {
  const { sqlite, db } = migratedSqlite();
  await seedCurrentInventory(db);

  const setRow = sqlite.prepare("SELECT id FROM products WHERE source_id = 'set-1'").get() as unknown as {
    id: number;
  };
  const setId = Number(setRow.id);

  // Simulate rows written by the previous classifier version. Every active listing becomes stale at
  // the same deployment boundary, while the set itself also carries the old one-category derived
  // state to prove replay repairs storage rather than merely advancing metadata.
  sqlite
    .prepare(`
      UPDATE products
      SET metadata_json = json_set(metadata_json, '$.categoryClassification.version', 14)
      WHERE is_active = 1
    `)
    .run();
  sqlite
    .prepare(`
      UPDATE products
      SET category = 'トランスポート',
          primary_category_id = 'transport',
          category_ids = '["transport"]',
          direct_category_ids = '["transport"]'
      WHERE id = ?
    `)
    .run(setId);
  sqlite.prepare("DELETE FROM product_categories WHERE product_id = ?").run(setId);
  sqlite
    .prepare(
      "INSERT INTO product_categories(product_id, category_id, is_direct) VALUES (?, 'transport', 1), (?, 'digital', 0)",
    )
    .run(setId, setId);

  // Keep the read side equally stale. The test would be weaker if product_categories said one thing
  // while the entity/card projection accidentally retained the already-correct two-category value.
  await refreshListingProjections(
    db,
    [{ shop_key: SHOP, source_id: "set-1" }],
    "2026-08-27T00:01:00.000Z",
  );
  const entityRow = sqlite
    .prepare(`
      SELECT e.entity_key
      FROM product_search_entity_offers m
      JOIN product_search_entities e ON e.id = m.entity_id
      WHERE m.listing_product_id = ?
    `)
    .get(setId) as unknown as { entity_key: string };
  const entityKey = entityRow.entity_key;
  const before = await searchProducts(db, productQuery("?includeTotal=true"));
  assert.deepEqual(
    before.items.find((item) => item.key === entityKey)?.direct_category_ids,
    ["transport"],
  );

  const first = await runDataQualityRemediationSweep(db, {
    seedLimit: 10,
    claimLimit: 1,
    leaseSeconds: 900,
    now: new Date("2026-08-27T01:00:00.000Z"),
  });
  assert.equal(first.seeded, 3, "the version bump must make every active fixture listing seedable");
  assert.equal(first.claimed, 1, "one invocation owns only one listing");
  assert.equal(first.resolved, 1);
  assert.equal(first.queue.pending, 2, "the rest stays durable for later invocations");

  const workTypes = sqlite
    .prepare("SELECT DISTINCT work_type FROM data_quality_remediation_queue ORDER BY work_type")
    .all() as unknown as { work_type: string }[];
  assert.deepEqual(workTypes.map((row) => row.work_type), ["classify_category"]);

  const second = await runDataQualityRemediationSweep(db, {
    seedLimit: 10,
    claimLimit: 1,
    leaseSeconds: 900,
    now: new Date("2026-08-27T01:01:00.000Z"),
  });
  assert.equal(second.seeded, 0, "already-seeded work is not duplicated while draining");
  assert.equal(second.claimed, 1);
  assert.equal(second.resolved, 1);
  assert.equal(second.queue.pending, 1);

  const third = await runDataQualityRemediationSweep(db, {
    seedLimit: 10,
    claimLimit: 1,
    leaseSeconds: 900,
    now: new Date("2026-08-27T01:02:00.000Z"),
  });
  assert.equal(third.seeded, 0);
  assert.equal(third.claimed, 1);
  assert.equal(third.resolved, 1);
  assert.equal(third.queue.pending, 0);
  assert.equal(third.queue.processing, 0);
  assert.equal(third.queue.backlog, 0);

  const currentRows = sqlite
    .prepare(`
      SELECT COUNT(*) AS count
      FROM products
      WHERE is_active = 1
        AND CAST(json_extract(metadata_json, '$.categoryClassification.version') AS INTEGER) = ?
    `)
    .get(CATEGORY_CLASSIFICATION_METADATA_VERSION) as unknown as { count: number };
  assert.equal(Number(currentRows.count), 3, "the whole active fixture inventory was replayed");

  const storedSet = sqlite
    .prepare("SELECT direct_category_ids FROM products WHERE id = ?")
    .get(setId) as unknown as { direct_category_ids: string };
  assert.deepEqual(JSON.parse(storedSet.direct_category_ids), ["dac", "transport"]);

  const directMembership = sqlite
    .prepare(`
      SELECT category_id
      FROM product_categories
      WHERE product_id = ? AND is_direct = 1
      ORDER BY category_id
    `)
    .all(setId) as unknown as { category_id: string }[];
  assert.deepEqual(directMembership.map((row) => row.category_id), ["dac", "transport"]);

  const after = await searchProducts(db, productQuery("?includeTotal=true"));
  const replayed = after.items.find((item) => item.key === entityKey);
  // This is the empirical taxonomy-order assertion requested by the issue handoff: DAC precedes
  // transport regardless of component order or SQLite row order.
  assert.deepEqual(replayed?.direct_category_ids, ["dac", "transport"]);

  for (const category of ["dac", "transport", "digital"]) {
    const found = await searchProducts(db, productQuery(`?category=${category}&includeTotal=true`));
    assert.equal(
      found.items.some((item) => item.key === entityKey),
      true,
      `the replayed set must remain searchable via ${category}`,
    );
  }
});
