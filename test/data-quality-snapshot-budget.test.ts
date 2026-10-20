import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import { readDataQualitySnapshot, saveDataQualityRun } from "../src/db/data-quality-repository.js";
import type { QualityCounts, QueryableDatabase } from "../src/db/types.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";

const FIXTURE = ["test/data-quality-snapshot-budget.test.ts"];
const LATER = "2026-09-05T02:00:00.000Z";
const CATEGORIES = [
  "AMP.INTEGRATED",
  "SPK.FLOOR",
  "CAB.RCA",
  "PWR.CONDITIONER",
  "ACC.INSULATOR",
  "REC.MEDIA",
  "cable_xlr",
  "vacuum_tube",
  "other",
];
// A crawl's own run-level counts never come from the aggregate.
const RUN = {
  parseAttemptCount: 40,
  parseSuccessCount: 39,
  parseFailureCount: 1,
  evidenceExpectedEventCount: 1,
  evidenceArchivedEventCount: 1,
  previousItemCount: 1000,
  currentItemCount: 990,
};

/** Quality-input variety, with resolution rows for two thirds of the listings. */
async function seedShop(
  db: QueryableDatabase,
  shopKey: string,
  from: number,
  to: number,
  active: 0 | 1,
) {
  await db
    .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
      INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,
        last_changed_at,stock_status,is_active,raw_manufacturer,manufacturer_resolution_status,
        classification_status,primary_category_id,model_resolution_status)
      SELECT i,?,'s'||i,'Listing '||i,'https://example.test/'||i,?,?,?,
        CASE i % 3 WHEN 0 THEN 'unknown' WHEN 1 THEN 'in_stock' ELSE 'sold_out' END,
        ?, CASE WHEN i % 5 = 0 THEN '' ELSE 'LUXMAN' END,
        CASE WHEN i % 4 = 0 THEN 'unresolved' ELSE 'resolved' END,
        CASE WHEN i % 13 = 0 THEN 'unclassified' ELSE 'classified' END,
        json_extract(?, '$[' || (i % CAST(? AS INTEGER)) || ']'),
        CASE WHEN i % 2 = 0 THEN 'resolved' ELSE 'unresolved' END
      FROM n`)
    .bind(from, to, shopKey, AT, AT, AT, active, JSON.stringify(CATEGORIES), CATEGORIES.length)
    .run();
  await db
    .prepare(`INSERT INTO product_identity_resolutions(listing_product_id,status,match_method,
        confidence,evaluated_at)
      SELECT id, CASE WHEN id % 3 = 0 THEN 'matched' ELSE 'unresolved' END,
        CASE WHEN id % 11 = 0 THEN 'vetoed' ELSE 'none' END, 'none', ?
      FROM products WHERE id BETWEEN ? AND ? AND id % 3 <> 1`)
    .bind(AT, from, to)
    .run();
}

async function fixture(size: number) {
  const handle = await database();
  await seedShop(handle.db, "large", 1, size, 1);
  await seedShop(handle.db, "large", size + 1, size + size / 5, 0);
  await seedShop(handle.db, "unrelated", 100_001, 102_000, 1);
  await saveDataQualityRun(handle.db, { shopKey: "large", evaluatedAt: AT });
  return handle;
}

async function measuredSave(db: QueryableDatabase, id: string, note: string) {
  const boundary = measureD1Cost(db);
  const saved = await saveDataQualityRun(boundary.db, {
    shopKey: "large",
    evaluatedAt: LATER,
    run: RUN,
  });
  const cost = boundary.metrics();
  await recordCostSample(id, "local-workerd", cost, FIXTURE, [note]);
  console.log(JSON.stringify({ sample: id, ...cost }));
  // Whichever path produced them, the snapshot counts equal a fresh aggregate of current inputs.
  const fresh = await readDataQualitySnapshot(db, "large");
  const snapshot = Object.fromEntries(
    Object.keys(fresh).map((key) => [key, saved.counts[key as keyof QualityCounts]]),
  );
  assert.deepEqual(snapshot, fresh);
  assert.equal(saved.counts.parseFailureCount, RUN.parseFailureCount);
  assert.equal(saved.counts.currentItemCount, RUN.currentItemCount);
  return { saved, cost };
}

for (const size of [1_000, 5_000]) {
  test(`re-evaluating ${size} unchanged listings reuses the covered snapshot`, async () => {
    const { db, dispose } = await fixture(size);
    try {
      // Another shop's quality input and this shop's non-input columns leave its proof intact.
      await db.prepare("UPDATE products SET stock_status = 'unknown' WHERE id = 100001").run();
      await db
        .prepare("UPDATE products SET last_seen_at = ?, price_yen = 1 WHERE id = 1")
        .bind(LATER)
        .run();
      const { cost } = await measuredSave(
        db,
        `dq-snapshot-unchanged-${size}`,
        `${size} active, ${size / 5} inactive and 2,000 other-shop listings; no quality input moved.`,
      );
      assert.equal(cost.sqlStatements, 3);
      assert.ok(cost.rowsRead !== null && cost.rowsRead <= 40, JSON.stringify(cost));
      assert.ok(cost.rowsWritten !== null && cost.rowsWritten <= 6, JSON.stringify(cost));
    } finally {
      await dispose();
    }
  }, 120_000);

  test(`re-evaluating ${size} listings after a quality input moved re-aggregates`, async () => {
    const { db, dispose } = await fixture(size);
    try {
      await db.prepare("UPDATE products SET stock_status = 'unknown' WHERE id = 1").run();
      await db
        .prepare(
          "UPDATE product_identity_resolutions SET status = 'matched' WHERE listing_product_id = 2",
        )
        .run();
      const { saved, cost } = await measuredSave(
        db,
        `dq-snapshot-changed-${size}`,
        `${size} active listings after one inventory and one identity change.`,
      );
      assert.equal(saved.counts.totalItems, size);
      assert.equal(cost.sqlStatements, 4);
      assert.ok(cost.rowsRead !== null && cost.rowsRead <= size * 2 + 40, JSON.stringify(cost));
      assert.ok(cost.rowsWritten !== null && cost.rowsWritten <= 6, JSON.stringify(cost));
    } finally {
      await dispose();
    }
  }, 120_000);
}
