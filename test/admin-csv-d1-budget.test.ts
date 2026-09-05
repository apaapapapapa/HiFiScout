import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { adminCsvOriginal, type AdminCsvChange } from "../src/api/admin-csv-contracts.js";
import { applyAdminCsvChange, previewAdminCsvChange } from "../src/db/admin-csv-import-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { AT, database, listing } from "./helpers/d1-write-budget.js";

test("D1 CSV import bills zero writes for unchanged and repeated edits and bounds measured no-op reads", async () => {
  const { db, dispose } = await database();
  try {
    await upsertProducts(db, "hifido", [listing("csv")], AT);
    const row = await db.prepare("SELECT id,canonical_manufacturer_id,model,primary_category_id FROM products WHERE source_id='csv'")
      .first<{ id: number; canonical_manufacturer_id: string; model: string; primary_category_id: string }>();
    assert.ok(row);
    const original = adminCsvOriginal("listing", row.id, {
      manufacturer_id: row.canonical_manufacturer_id, model: row.model, primary_category_id: row.primary_category_id,
    });
    const unchanged = { line: 2, original, values: original.values };
    const noOp = accountReads(db);
    assert.equal((await previewAdminCsvChange(noOp.db, unchanged)).status, "unchanged");
    assert.equal(noOp.countedStatements(), 2);
    assert.equal(noOp.rowsWritten(), 0);
    assert.ok(noOp.rowsRead() < 20, "no-op must be indexed lookups, not a product or receipt scan");

    const change: AdminCsvChange = { line: 2, original, values: { ...original.values, model: "C11" } };
    const preview = await previewAdminCsvChange(db, change);
    assert.equal(preview.status, "ready");
    const input = { change, revision: preview.revision || "", operationId: crypto.randomUUID() };
    const changed = accountReads(db);
    const result = await applyAdminCsvChange(changed.db, input);
    assert.equal(result.status, "applied", result.message);
    assert.ok(changed.rowsWritten() > 0);
    assert.ok(changed.rowsWritten() < 500, "one listing must not rewrite unrelated products");
    assert.ok(changed.statementCount() < 200);

    const repeated = accountReads(db);
    assert.equal((await applyAdminCsvChange(repeated.db, input)).status, "applied");
    assert.equal((await previewAdminCsvChange(repeated.db, change)).status, "unchanged");
    assert.equal(repeated.rowsWritten(), 0);
    assert.ok(repeated.countedStatements() >= 4);
    assert.ok(repeated.rowsRead() < 30);
  } finally { await dispose(); }
}, 30_000);

test("D1 batch revision guard atomically preserves the winning catalog edit and old evidence", async () => {
  const { db, dispose } = await database();
  try {
    await db.prepare(`INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
      VALUES ('luxman','LUXMAN','2026-09-05','2026-09-05');
      INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
      VALUES(1,'luxman','C10','C10','LUXMAN C10','2026-09-05','2026-09-05');
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES(1,'AMP.PRE',1);
      INSERT INTO knowledge_catalog_aliases(product_id,alias,normalized_alias,alias_type,created_at)
      VALUES(1,'C-10','C-10','model','2026-09-05');`).run();
    const original = adminCsvOriginal("catalog", 1, {
      manufacturer_id: "luxman", canonical_model: "C10", canonical_name: "LUXMAN C10",
      primary_category_id: "AMP.PRE", lifecycle_status: "unknown",
    });
    const change = { line: 2, original, values: { ...original.values, canonical_model: "C11" } };
    const preview = await previewAdminCsvChange(db, change);
    assert.equal(preview.status, "ready");
    const racing = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db.prepare("UPDATE knowledge_catalog_products SET canonical_name='Race winner' WHERE id=1").run();
        return db.batch(statements);
      },
    };
    const result = await applyAdminCsvChange(racing, { change, revision: preview.revision || "", operationId: crypto.randomUUID() });
    assert.equal(result.status, "failed");
    assert.equal(await db.prepare("SELECT canonical_name FROM knowledge_catalog_products WHERE id=1").first("canonical_name"), "Race winner");
    assert.equal(await db.prepare("SELECT canonical_model FROM knowledge_catalog_products WHERE id=1").first("canonical_model"), "C10");
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM knowledge_catalog_aliases WHERE product_id=1").first("n"), 1);
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").first("n"), 0);
  } finally { await dispose(); }
}, 30_000);
