import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import { reprocessPendingCatalogRemediation } from "../src/db/knowledge-catalog-remediation-repository.js";
import { database, AT, NEXT } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";

test("the remediation backlog drain stays bounded as replayed verified entries grow", async () => {
  const { db, dispose } = await database();
  const fixture = ["test/catalog-remediation-backlog-budget.test.ts"];
  try {
    let previous = 0;
    const reads: number[] = [];
    for (const size of [100, 1000, 10000]) {
      // Already replayed entries are the bulk of a mature catalog and are not owed anything.
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
          INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,
            verification_status,last_verified_at,last_remediated_at,created_at,updated_at)
          SELECT 'brand-'||(i%50),'DONE-'||i,'DONE-'||i,'verified',?,?,?,? FROM n`)
        .bind(previous + 1, size, AT, NEXT, AT, AT)
        .run();
      previous = size;
      // Three newly verified entries and one re-verified after its last replay form the backlog.
      await db
        .prepare(`INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,
            verification_status,last_verified_at,created_at,updated_at)
          VALUES ('luxman',?1,?1,'verified',?2,?2,?2),('luxman',?1||'A',?1||'A','verified',?2,?2,?2),
            ('luxman',?1||'B',?1||'B','verified',?2,?2,?2)`)
        .bind(`NEW-${size}`, AT)
        .run();
      await db
        .prepare(`UPDATE knowledge_catalog_products SET last_verified_at = ?
          WHERE canonical_model = ?`)
        .bind("2026-09-06T00:00:00.000Z", `DONE-${size}`)
        .run();

      const boundary = measureD1Cost(db);
      const summary = await reprocessPendingCatalogRemediation(boundary.db, {
        productLimit: 20,
        limit: 10,
        evaluatedAt: "2026-09-07T00:00:00.000Z",
      });
      const cost = boundary.metrics();
      await recordCostSample(
        `catalog-remediation-backlog-${size}`,
        "local-workerd",
        cost,
        fixture,
        [`Four owed entries amid ${size} replayed verified entries; real migrated D1.`],
      );
      assert.equal(summary.catalogProducts, 4);
      assert.equal(summary.pendingProducts, 0);
      assert.equal(summary.hasMoreProducts, false);
      assert.ok(cost.rowsRead !== null && cost.rowsRead <= 80, JSON.stringify(cost));
      reads.push(cost.rowsRead);
      console.log(JSON.stringify({ sample: `catalog-remediation-backlog-${size}`, ...cost }));

      // A drained backlog is empty: the next finalizer reads only the index it walks.
      const idle = measureD1Cost(db);
      const repeat = await reprocessPendingCatalogRemediation(idle.db, { productLimit: 20 });
      assert.equal(repeat.catalogProducts, 0);
      const idleCost = idle.metrics();
      assert.equal(idleCost.rowsWritten, 0);
      assert.ok(idleCost.rowsRead !== null && idleCost.rowsRead <= 2, JSON.stringify(idleCost));
    }
    assert.equal(new Set(reads).size, 1, `reads must not grow with replayed entries: ${reads}`);
  } finally {
    await dispose();
  }
}, 60_000);
