import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { categorySearchAliases, getCategory } from "../src/catalog/categories.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { syncProductMetadata } from "../src/db/product-metadata-repository.js";
import { recordCostSample } from "../scripts/harness/cost.js";
import { AT, NEXT, database, listing } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { invocationBudget } from "../src/db/invocation-budget.js";

for (const size of [100, 1_000, 10_000]) {
  test(`manual category crawl replay and immediate price changes at ${size} listings`, async () => {
    const { db, dispose } = await database();
    try {
      const input = listing("0");
      await upsertProducts(db, "override-cost", [input], AT);
      await syncProductMetadata(db, "override-cost", [input], AT);
      const info = await db.prepare("PRAGMA table_info(products)").all<{ name: string }>();
      const columns = info.results
        .map((row: { name: string }) => row.name)
        .filter((name: string) => !["id", "source_id"].includes(name));
      await db
        .prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(source_id,${columns.join(",")})
        SELECT CAST(n.i AS TEXT),${columns.map((c: string) => `p.${c}`).join(",")}
        FROM products p CROSS JOIN n WHERE p.shop_key='override-cost' AND p.source_id='0'`)
        .bind(size - 1)
        .run();
      const category = getCategory("AMP.PRE")!;
      const aliases = categorySearchAliases([category.id]);
      await db
        .prepare(`INSERT INTO product_admin_overrides(listing_product_id,primary_category_id,
        category_ids,category_name,search_aliases,created_at,updated_at)
        SELECT id,?1,'["AMP.PRE"]',?2,?3,?4,?4 FROM products WHERE shop_key='override-cost'`)
        .bind(category.id, category.name, aliases, AT)
        .run();
      await db
        .prepare(`UPDATE products SET category=?1,primary_category_id='AMP.PRE',category_ids='["AMP.PRE"]',
        direct_category_ids='["AMP.PRE"]',classification_status='classified',search_aliases=?2
        WHERE shop_key='override-cost'`)
        .bind(category.name, aliases)
        .run();
      // This fixture represents already-projected rows; projection behavior has its own real-D1 gate.
      await db.prepare("DELETE FROM listing_projection_pending").run();
      for (const scenario of ["unchanged", "few-price", "many-price"] as const) {
        const products = Array.from({ length: size }, (_, i) => ({
          ...input,
          sourceId: String(i),
          priceYen:
            scenario === "many-price" || (scenario === "few-price" && i % 100 === 0)
              ? 90000
              : input.priceYen,
        }));
        const measured = measureD1Cost(db);
        const calls = invocationBudget(measured.db, { maxCalls: 100_000, maxWallMs: 600_000 });
        const started = performance.now();
        const result = await upsertProducts(calls.db, "override-cost", products, NEXT);
        const elapsedMs = performance.now() - started;
        const metrics = { ...measured.metrics(), d1Calls: calls.metrics().d1Calls };
        await recordCostSample(
          `category-override-${scenario}-${size}`,
          "local-workerd",
          metrics,
          ["test/category-repeat-write-budget.test.ts"],
          [
            "Identical seller classification conflicts with a persisted manual category; same-row price changes remain immediate; setup excluded.",
          ],
        );
        const row = await db
          .prepare(`SELECT COUNT(*) n,SUM(primary_category_id='AMP.PRE') preserved,
          SUM(price_yen=90000) changed_price FROM products WHERE shop_key='override-cost'`)
          .first();
        assert.deepEqual(row, {
          n: size,
          preserved: size,
          changed_price:
            scenario === "many-price" ? size : scenario === "few-price" ? size / 100 : 0,
        });
        console.log(
          JSON.stringify({
            event: "category_override_cost",
            size,
            scenario,
            ...metrics,
            sqlDurationMs: measured.sqlDurationMs(),
            elapsedMs,
            changedCount: result.changedCount,
          }),
        );
      }
    } finally {
      await dispose();
    }
  }, 600_000);
}
