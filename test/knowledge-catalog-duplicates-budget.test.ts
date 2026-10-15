import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import { listKnowledgeCatalogDuplicates } from "../src/db/knowledge-catalog-duplicate-repository.js";
import { database, AT } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";

test("catalog duplicate pages stay bounded as unrelated verified singletons grow", async () => {
  const { db, dispose } = await database();
  const fixture = ["test/knowledge-catalog-duplicates-budget.test.ts"];
  try {
    // Two real duplicate sets plus one coarse bucket shared by two manufacturers, which the
    // identity refinement must still reject.
    for (const [manufacturerId, model] of [
      ["denon", "PMA-2500NE"],
      ["denon", "PMA2500NE"],
      ["luxman", "L-509X"],
      ["luxman", "L509X"],
      ["onkyo", "A-10"],
      ["accuphase", "A10"],
    ]) {
      await db
        .prepare(`INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,
          canonical_name,verification_status,first_verified_at,last_verified_at,created_at,updated_at)
          VALUES (?,?,?,?,'verified',?,?,?,?)`)
        .bind(manufacturerId, model, model, `${manufacturerId} ${model}`, AT, AT, AT, AT)
        .run();
    }
    await db
      .prepare(`INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
        SELECT id,'AMP.INTEGRATED',1 FROM knowledge_catalog_products`)
      .run();

    let previous = 0;
    const reads: number[] = [];
    for (const size of [100, 1000, 10000]) {
      // Singletons never share a coarse bucket, so the trigger-maintained projection ignores them.
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
          INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,
            canonical_name,verification_status,first_verified_at,last_verified_at,created_at,updated_at)
          SELECT 'brand-'||(i%50),'SOLO-'||i,'SOLO-'||i,'Solo '||i,'verified',?,?,?,? FROM n`)
        .bind(previous + 1, size, AT, AT, AT, AT)
        .run();
      previous = size;

      // The finalizer's convergence pass requests this page shape.
      const boundary = measureD1Cost(db);
      const page = await listKnowledgeCatalogDuplicates(boundary.db, {
        manufacturerId: "",
        afterKey: "",
        limit: 5,
      });
      const cost = boundary.metrics();
      await recordCostSample(`catalog-duplicates-${size}`, "local-workerd", cost, fixture, [
        `Five-group duplicate page with ${size} unrelated verified singletons; real migrated D1.`,
      ]);
      assert.deepEqual(
        page.items.map((group) => [group.manufacturerId, group.identityModel]),
        [
          ["luxman", "L509X"],
          ["denon", "PMA2500NE"],
        ],
      );
      assert.equal(page.hasMore, false);
      assert.equal(cost.rowsWritten, 0);
      assert.equal(cost.sqlStatements, 1);
      assert.ok(cost.rowsRead !== null && cost.rowsRead <= 60, JSON.stringify(cost));
      reads.push(cost.rowsRead);

      const filtered = await listKnowledgeCatalogDuplicates(db, {
        manufacturerId: "denon",
        afterKey: "",
        limit: 20,
      });
      assert.deepEqual(
        filtered.items.map((group) => group.identityModel),
        ["PMA2500NE"],
      );
      console.log(JSON.stringify({ sample: `catalog-duplicates-${size}`, ...cost }));
    }
    assert.equal(new Set(reads).size, 1, `reads must not grow with singletons: ${reads}`);
  } finally {
    await dispose();
  }
}, 60_000);
