import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { readAdminWorkCounts } from "../src/db/admin-work-counts-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { database, AT } from "./helpers/d1-write-budget.js";

test("D1 work counts use two read-only bounded statements as catalog and individual buckets grow", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<10000)
      INSERT INTO product_correction_reports(product_key,reason,status,created_at,updated_at)
      SELECT 'catalog:'||id,'wrong_model',CASE WHEN id%2=0 THEN 'open' ELSE 'accepted' END,?,? FROM n`)
      .bind(AT, AT)
      .run();
    await db
      .prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<10000)
      INSERT INTO knowledge_catalog_candidates(manufacturer_id,normalized_model,review_status,last_reviewed_at,created_at,updated_at)
      SELECT 'luxman','CANDIDATE'||id,CASE WHEN id%2=0 THEN 'pending' ELSE 'matched' END,?,?,? FROM n`)
      .bind(AT, AT, AT)
      .run();
    let previousSize = 0;
    for (const size of [100, 1000, 10000]) {
      await db
        .prepare(`WITH RECURSIVE n(id) AS (VALUES(?) UNION ALL SELECT id+1 FROM n WHERE id<?)
        INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
        SELECT 'luxman','UNRELATED'||id,'UNRELATED'||id,?,? FROM n`)
        .bind(previousSize + 1, size, AT, AT)
        .run();
      previousSize = size;
      const measured = accountReads(db);
      const result = await readAdminWorkCounts(measured.db, { bucketKey: "", afterId: 0 });
      assert.deepEqual(result.duplicateIdentities, []);
      assert.equal(result.reports, 100);
      assert.equal(result.candidates, 100);
      assert.ok(measured.rowsRead() < 250, `${size} rows: ${measured.rowsRead()} reads`);
      assert.equal(measured.rowsWritten(), 0);
      assert.equal(measured.statementCount(), 2);
    }
    // A coarse bucket may contain thousands of unrelated manufacturers. Even a continuation
    // deep inside it must seek, rather than re-read earlier rows or load the whole bucket.
    await db
      .prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<2000)
      INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
      SELECT 'unknown-'||id,'COARSE1','COARSE1',?,? FROM n`)
      .bind(AT, AT)
      .run();
    const deep = await db
      .prepare(
        "SELECT product_id FROM knowledge_catalog_duplicate_members ORDER BY bucket_key,product_id LIMIT 1 OFFSET 1500",
      )
      .first<{ product_id: number }>();
    assert.ok(deep);
    for (const afterId of [0, deep.product_id]) {
      const measured = accountReads(db);
      const result = await readAdminWorkCounts(measured.db, { bucketKey: "COARSE1", afterId });
      assert.equal(result.duplicateIdentities.length, 200);
      assert.ok(result.nextDuplicateCursor);
      assert.ok(measured.rowsRead() < 900, `cursor ${afterId}: ${measured.rowsRead()} reads`);
      assert.equal(measured.rowsWritten(), 0);
      assert.equal(measured.statementCount(), 2);
    }
    const unchanged = accountReads(db);
    await unchanged.db
      .prepare(`UPDATE knowledge_catalog_products SET normalized_model=normalized_model,
      verification_status=verification_status WHERE id=?`)
      .bind(deep.product_id)
      .run();
    // The source UPDATE itself is billable; the projection's guarded triggers must not rewrite peers.
    assert.ok(unchanged.rowsWritten() < 10, `unchanged write: ${unchanged.rowsWritten()}`);
    const added = accountReads(db);
    await added.db
      .prepare(`INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
      VALUES ('new-unknown','COARSE1','COARSE1',?,?)`)
      .bind(AT, AT)
      .run();
    assert.ok(added.rowsRead() < 80, `large bucket insert: ${added.rowsRead()} reads`);
    assert.ok(added.rowsWritten() < 30, `large bucket insert: ${added.rowsWritten()} writes`);
    const removed = accountReads(db);
    await removed.db
      .prepare("DELETE FROM knowledge_catalog_products WHERE id=?")
      .bind(deep.product_id)
      .run();
    assert.ok(removed.rowsRead() < 80, `large bucket delete: ${removed.rowsRead()} reads`);
    assert.ok(removed.rowsWritten() < 30, `large bucket delete: ${removed.rowsWritten()} writes`);
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN SELECT dm.product_id
      FROM knowledge_catalog_duplicate_members dm JOIN knowledge_catalog_products kp ON kp.id=dm.product_id
      WHERE (dm.bucket_key,dm.product_id) > (?,?) ORDER BY dm.bucket_key,dm.product_id LIMIT 201`)
      .bind("COARSE1", deep.product_id)
      .all<{ detail: string }>();
    assert.ok(
      plan.results.some((row: { detail: string }) =>
        row.detail.includes("SEARCH dm USING PRIMARY KEY"),
      ),
    );
    assert.ok(
      !plan.results.some((row: { detail: string }) => /SCAN kp|TEMP B-TREE/.test(row.detail)),
    );
  } finally {
    await dispose();
  }
}, 30_000);
