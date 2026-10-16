import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import { deactivateProductsBySourceIds } from "../src/db/product-write-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { AT, database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";

const MISSING = 50;

function insertListings(db: QueryableDatabase, prefix: string, from: number, to: number) {
  return db
    .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
      INSERT INTO products(shop_key,source_id,title,source_url,first_seen_at,last_seen_at,
        last_changed_at,is_active)
      SELECT 'shop',?||i,'Amp','https://example.test/'||?||i,?,?,?,1 FROM n`)
    .bind(from, to, prefix, prefix, AT, AT, AT)
    .run();
}

test("deactivating missing listings stays bounded as the shop's active listings grow", async () => {
  const fixture = ["test/crawl-deactivation-budget.test.ts"];
  // No statistics, and statistics that omit the shop cursor index added after the last ANALYZE.
  for (const stats of ["none", "without-cursor-index"]) {
    const { db, dispose } = await database();
    try {
      await insertListings(db, "kept-", 1, 100);
      if (stats !== "none") {
        await db.prepare("ANALYZE").run();
        await db
          .prepare("DELETE FROM sqlite_stat1 WHERE idx = 'idx_products_admin_shop_cursor'")
          .run();
        await db.prepare("ANALYZE sqlite_schema").run();
      }
      let previous = 100;
      const reads: number[] = [];
      for (const size of [100, 1000, 10000]) {
        if (size > previous) await insertListings(db, "kept-", previous + 1, size);
        previous = size;
        // The listings a complete crawl no longer saw, fresh for every size.
        await insertListings(db, `gone-${size}-`, 1, MISSING);
        const ids = Array.from({ length: MISSING }, (_, i) => `gone-${size}-${i + 1}`);

        const boundary = measureD1Cost(db);
        await deactivateProductsBySourceIds(boundary.db, "shop", ids);
        const cost = boundary.metrics();
        const inactive = await db
          .prepare("SELECT COUNT(*) AS n FROM products WHERE is_active = 0 AND source_id LIKE ?")
          .bind(`gone-${size}-%`)
          .first<{ n: number }>();
        assert.equal(inactive?.n, MISSING);
        assert.equal(cost.sqlStatements, 1);
        reads.push(cost.rowsRead ?? -1);
        if (stats === "none")
          await recordCostSample(
            `crawl-deactivate-missing-${size}`,
            "local-workerd",
            cost,
            fixture,
            [
              `${MISSING} missing listings among ${size} active listings of the same shop; no statistics.`,
            ],
          );
        console.log(JSON.stringify({ stats, size, ...cost }));
      }
      // Trigger bookkeeping varies by a row; one scan of the shop would add a row per listing.
      assert.ok(Math.max(...reads) - Math.min(...reads) <= 2, `${stats}: reads grew: ${reads}`);
      assert.ok(Math.max(...reads) <= 1000, `${stats}: ${reads}`);
    } finally {
      await dispose();
    }
  }
}, 120_000);
