import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import { readAdminChangeHistory } from "../src/db/admin-change-history-repository.js";

test("history inspection stays bounded as unrelated editor and CSV receipts grow", async () => {
  const { db, dispose } = await database();
  try {
    for (const table of ["admin_product_change_log", "admin_csv_import_changes"]) {
      const extraColumns =
        table === "admin_csv_import_changes" ? ", revision, status, updated_at" : "";
      const extraValues = table === "admin_csv_import_changes" ? ", '', 'applied', ''" : "";
      await db
        .prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<2000)
        INSERT INTO ${table}(operation_id,target_kind,target_id,before_json,after_json,created_at${extraColumns})
        SELECT 'history-'||id, 'listing', CASE WHEN id<35 THEN 1 ELSE id END, '{"values":{}}', '{}', '2026-01-01'${extraValues} FROM n`)
        .run();
    }
    const measured = accountReads(db);
    const history = await readAdminChangeHistory(measured.db, "listing", 1);
    assert.equal(history.items.length, 25);
    assert.equal(history.hasMore, true);
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(measured.rowsRead() < 150, `reads=${measured.rowsRead()}`);
    assert.equal(measured.statementCount(), 3);
  } finally {
    await dispose();
  }
}, 30_000);
