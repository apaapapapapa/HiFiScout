import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { scanAdminModelReplay, needsAdminModelReplay } from "../src/db/admin-model-replay.js";
import { MODEL_RESOLVER_VERSION } from "../src/catalog/model-resolver.js";
import { accountReads } from "../src/db/read-accounting.js";
import { database } from "./helpers/d1-write-budget.js";

test("admin model replay bounds empty-window discovery and point checks as the inventory grows", async () => {
  const { db, dispose } = await database();
  const costs: { size: number; reads: number; writes: number; statements: number }[] = [];
  try {
    let previous = 0;
    for (const size of [100, 10000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,model_resolver_version)
        SELECT i,'budget',CAST(i AS TEXT),'test','https://example.test/'||i,'','','',? FROM n`)
        .bind(previous + 1, size, MODEL_RESOLVER_VERSION)
        .run();
      const measured = accountReads(db);
      const page = await scanAdminModelReplay(measured.db, 0, size);
      assert.equal(page.scanned, 25);
      assert.deepEqual(page.ids, []);
      assert.equal(page.complete, false);
      assert.equal(await needsAdminModelReplay(measured.db, size), false);
      costs.push({
        size,
        reads: measured.rowsRead(),
        writes: measured.rowsWritten(),
        statements: measured.statementCount(),
      });
      previous = size;
    }
    assert.ok(
      costs.every((c) => c.reads <= 30 && c.writes === 0 && c.statements === 2),
      JSON.stringify(costs),
    );
    assert.ok(costs[1].reads <= costs[0].reads + 1, JSON.stringify(costs));
    await db.prepare("UPDATE products SET model_resolver_version=1 WHERE id=10000").run();
    const tail = await scanAdminModelReplay(db, 9999, 10000);
    assert.deepEqual(tail.ids, [10000]);
    assert.equal(tail.complete, true);
    assert.equal(await needsAdminModelReplay(db, 10000), true);
    console.log(JSON.stringify({ event: "admin_model_replay_scan_budget", costs }));
  } finally {
    await dispose();
  }
}, 30000);
