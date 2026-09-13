import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  readCatalogReplaySnapshot,
  scanAdminCatalogReplay,
} from "../src/db/admin-catalog-replay.js";
import { accountReads, dbUsageMetrics } from "../src/db/read-accounting.js";
import { database } from "./helpers/d1-write-budget.js";

test("catalog replay checks use indexed candidate keys and bounded listing windows as unrelated data grows", async () => {
  const { db, dispose } = await database();
  const costs: { size: number; reads: number; writes: number; statements: number }[] = [];
  try {
    await db
      .prepare(`INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
      VALUES ('luxman','LUXMAN','','')`)
      .run();
    await db
      .prepare(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,
      canonical_name,verification_status,created_at,updated_at)
      VALUES (900001,'luxman','TEST-700','TEST700','TEST-700','verified','','')`)
      .run();
    await db
      .prepare(`INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
      VALUES (900001,'AMP.PRE',1)`)
      .run();
    let previous = 0;
    let original = "";
    for (const size of [100, 10000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,model,canonical_manufacturer_id,source_url,
          first_seen_at,last_seen_at,last_changed_at)
        SELECT i,'budget',CAST(i AS TEXT),'LUXMAN TEST-700','TEST-700','luxman','https://example.test/'||i,'','','' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,
          verification_status,created_at,updated_at)
        SELECT i,'luxman','UNRELATED-'||i,'UNRELATED'||i,'UNRELATED-'||i,'verified','','' FROM n`)
        .bind(previous + 1, size)
        .run();
      const measured = accountReads(db);
      const page = await scanAdminCatalogReplay(measured.db, 0, size);
      assert.equal(page.scanned, 25);
      assert.equal(page.complete, false);
      const snapshot = await readCatalogReplaySnapshot(measured.db, 1);
      assert.ok(snapshot);
      if (original) assert.equal(snapshot.fingerprint, original);
      original = snapshot.fingerprint;
      const usage = dbUsageMetrics(measured);
      costs.push({
        size,
        reads: usage.rowsRead,
        writes: usage.rowsWritten,
        statements: usage.statementCount,
      });
      previous = size;
    }
    assert.ok(
      costs.every((cost) => cost.writes === 0 && cost.reads <= 150),
      JSON.stringify(costs),
    );
    assert.ok(costs[1].reads <= costs[0].reads + 1, JSON.stringify(costs));
    assert.equal(costs[1].statements, costs[0].statements);
    console.log(JSON.stringify({ event: "admin_catalog_replay_check_budget", costs }));
  } finally {
    await dispose();
  }
}, 30000);
