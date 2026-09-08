import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import { previewAdminExtraction } from "../src/admin/extraction-preview.js";

test("extraction previews read selected primary keys and a bounded reference dictionary", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`WITH RECURSIVE n(id) AS (VALUES(100001) UNION ALL SELECT id+1 FROM n WHERE id<104000)
      INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,manufacturer,raw_manufacturer,raw_model,primary_category_id)
      SELECT id,'audiounion','preview-'||id,'LUXMAN L-505 アンプ','https://example.test/','','','','LUXMAN','LUXMAN','L-505','unclassified' FROM n`)
      .run();
    const measured = accountReads(db);
    const result = await previewAdminExtraction(measured.db, {
      samples: [{ listingId: 100001 }, { listingId: 104000 }],
    });
    assert.equal(result.items.length, 2);
    assert.equal(measured.statementCount(), 2);
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(measured.rowsRead() < 2200, `reads=${measured.rowsRead()}`);
  } finally {
    await dispose();
  }
}, 30_000);
