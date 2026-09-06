import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  adminCsvOriginal,
  adminCsvNewCatalog,
  type AdminCsvChange,
} from "../src/api/admin-csv-contracts.js";
import {
  applyAdminCsvChange,
  previewAdminCsvChange,
} from "../src/db/admin-csv-import-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { AT, database, listing } from "./helpers/d1-write-budget.js";
import { propagateCatalogCategoryToMatchedListings } from "../src/db/knowledge-catalog-admin-repository.js";
import { reclassifyAdminCsvListings } from "../src/db/knowledge-catalog-repository.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";

test("D1 CSV additions keep duplicate reads bounded as the catalog grows and retries bill zero writes", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
      VALUES('luxman','LUXMAN','${AT}','${AT}')`)
      .run();
    let previousSize = 0;
    for (const size of [100, 1000, 10000]) {
      await db
        .prepare(`WITH RECURSIVE n(id) AS (VALUES(?) UNION ALL SELECT id+1 FROM n WHERE id<?)
        INSERT INTO knowledge_catalog_products(manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
        SELECT 'luxman','UNRELATED'||id,'UNRELATED'||id,'${AT}','${AT}' FROM n`)
        .bind(previousSize + 1, size)
        .run();
      previousSize = size;
      const change = {
        line: 2,
        original: adminCsvNewCatalog(),
        values: {
          manufacturer_id: "luxman",
          canonical_model: "CSVNEW" + size,
          canonical_name: "LUXMAN CSVNEW" + size,
          primary_category_id: "AMP.PRE",
          lifecycle_status: "unknown",
        },
      };
      const measured = accountReads(db);
      const preview = await previewAdminCsvChange(measured.db, change);
      assert.equal(preview.status, "ready", preview.message);
      const input = { change, revision: preview.revision || "", operationId: crypto.randomUUID() };
      const result = await applyAdminCsvChange(measured.db, input);
      assert.equal(result.status, "applied", result.message);
      assert.ok(result.id);
      assert.ok(measured.rowsRead() < 200, `${size} catalog rows: reads=${measured.rowsRead()}`);
      assert.ok(measured.rowsWritten() < 100, `writes=${measured.rowsWritten()}`);
      assert.ok(measured.statementCount() < 35, `statements=${measured.statementCount()}`);
      const repeated = accountReads(db);
      assert.equal((await applyAdminCsvChange(repeated.db, input)).id, result.id);
      assert.equal((await previewAdminCsvChange(repeated.db, change)).status, "unchanged");
      assert.equal(
        (await applyAdminCsvChange(repeated.db, { ...input, operationId: crypto.randomUUID() }))
          .status,
        "unchanged",
      );
      assert.equal(repeated.rowsWritten(), 0);
      assert.ok(repeated.rowsRead() < 100, `replay reads=${repeated.rowsRead()}`);
    }
  } finally {
    await dispose();
  }
}, 30_000);

test("D1 CSV catalog corrections with no related listings complete in one request without cursor writes", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
      VALUES('luxman','LUXMAN','${AT}','${AT}');
      INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
      VALUES(1,'luxman','CSV-TUNER','CSVTUNER','LUXMAN CSV-TUNER','${AT}','${AT}');`)
      .run();
    const original = adminCsvOriginal("catalog", 1, {
      manufacturer_id: "luxman",
      canonical_model: "CSV-TUNER",
      canonical_name: "LUXMAN CSV-TUNER",
      primary_category_id: "",
      lifecycle_status: "unknown",
    });
    const change = {
      line: 2,
      original,
      values: { ...original.values, primary_category_id: "SRC.TUNER" },
    };
    const preview = await previewAdminCsvChange(db, change);
    assert.equal(preview.status, "ready", preview.message);
    const input = { change, revision: preview.revision || "", operationId: crypto.randomUUID() };
    const measured = accountReads(db);
    const result = await applyAdminCsvChange(measured.db, input);
    assert.equal(result.status, "applied", "empty phases must not require another browser request");
    assert.ok(measured.statementCount() < 35, `statements=${measured.statementCount()}`);
    assert.ok(measured.rowsRead() < 150, `rows_read=${measured.rowsRead()}`);
    const receipt = await db
      .prepare(
        "SELECT phase,after_listing_id,status FROM admin_csv_import_changes WHERE operation_id=?",
      )
      .bind(input.operationId)
      .first();
    assert.deepEqual(receipt, { phase: 0, after_listing_id: 0, status: "applied" });
    const repeated = accountReads(db);
    assert.equal((await applyAdminCsvChange(repeated.db, input)).status, "applied");
    assert.equal(repeated.rowsWritten(), 0);
  } finally {
    await dispose();
  }
}, 30_000);

test("D1 CSV import bills zero writes for unchanged and repeated edits and bounds measured no-op reads", async () => {
  const { db, dispose } = await database();
  try {
    await upsertProducts(db, "hifido", [listing("csv")], AT);
    const row = await db
      .prepare(
        "SELECT id,canonical_manufacturer_id,model,primary_category_id FROM products WHERE source_id='csv'",
      )
      .first<{
        id: number;
        canonical_manufacturer_id: string;
        model: string;
        primary_category_id: string;
      }>();
    assert.ok(row);
    const original = adminCsvOriginal("listing", row.id, {
      manufacturer_id: row.canonical_manufacturer_id,
      model: row.model,
      primary_category_id: row.primary_category_id,
    });
    const unchanged = { line: 2, original, values: original.values };
    const noOp = accountReads(db);
    assert.equal((await previewAdminCsvChange(noOp.db, unchanged)).status, "unchanged");
    assert.equal(noOp.countedStatements(), 2);
    assert.equal(noOp.rowsWritten(), 0);
    assert.ok(noOp.rowsRead() < 20, "no-op must be indexed lookups, not a product or receipt scan");

    const change: AdminCsvChange = {
      line: 2,
      original,
      values: { ...original.values, model: "C11" },
    };
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
  } finally {
    await dispose();
  }
}, 30_000);

test("D1 repeated CSV category propagation bills zero writes after its first successful refresh", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
      VALUES('luxman','LUXMAN','${AT}','${AT}');
      INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
      VALUES(1,'luxman','C10','C10','LUXMAN C10','${AT}','${AT}');
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
      VALUES(1,'AMP.PRE',1),(1,'AMP',0);`)
      .run();
    await upsertProducts(db, "hifido", [listing("csv-category")], AT);
    const rows = await db
      .prepare("SELECT id,shop_key,source_id FROM products WHERE source_id='csv-category'")
      .all<{ id: number; shop_key: string; source_id: string }>();
    const ids = rows.results.map((row: { id: number }) => row.id);
    await refreshListingProjections(db, rows.results, AT);
    assert.equal(
      await db
        .prepare(
          "SELECT catalog_product_id FROM product_identity_resolutions WHERE listing_product_id=?",
        )
        .bind(ids[0])
        .first("catalog_product_id"),
      1,
    );
    await propagateCatalogCategoryToMatchedListings(db, 1, ["AMP.PRE", "AMP"], AT, ids);
    const repeated = accountReads(db);
    await propagateCatalogCategoryToMatchedListings(repeated.db, 1, ["AMP.PRE", "AMP"], AT, ids);
    await reclassifyAdminCsvListings(repeated.db, ids, AT);
    assert.equal(
      repeated.rowsWritten(),
      0,
      "a retry must not rewrite category membership or projection tokens",
    );
    assert.ok(repeated.rowsRead() < 300, `retry read ${repeated.rowsRead()} rows`);
    assert.ok(
      repeated.statementCount() < 60,
      `retry issued ${repeated.statementCount()} statements`,
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("D1 batch revision guard atomically preserves the winning catalog edit and old evidence", async () => {
  const { db, dispose } = await database();
  try {
    await db
      .prepare(`INSERT OR IGNORE INTO knowledge_catalog_manufacturers(id,canonical_name,created_at,updated_at)
      VALUES ('luxman','LUXMAN','2026-09-05','2026-09-05');
      INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
      VALUES(1,'luxman','C10','C10','LUXMAN C10','2026-09-05','2026-09-05');
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES(1,'AMP.PRE',1);
      INSERT INTO knowledge_catalog_aliases(product_id,alias,normalized_alias,alias_type,created_at)
      VALUES(1,'C-10','C-10','model','2026-09-05');`)
      .run();
    const original = adminCsvOriginal("catalog", 1, {
      manufacturer_id: "luxman",
      canonical_model: "C10",
      canonical_name: "LUXMAN C10",
      primary_category_id: "AMP.PRE",
      lifecycle_status: "unknown",
    });
    const change = { line: 2, original, values: { ...original.values, canonical_model: "C11" } };
    const preview = await previewAdminCsvChange(db, change);
    assert.equal(preview.status, "ready");
    const racing = {
      prepare: db.prepare.bind(db),
      async batch<T = unknown>(statements: D1PreparedStatement[]) {
        await db
          .prepare("UPDATE knowledge_catalog_products SET canonical_name='Race winner' WHERE id=1")
          .run();
        return db.batch<T>(statements);
      },
    };
    const result = await applyAdminCsvChange(racing, {
      change,
      revision: preview.revision || "",
      operationId: crypto.randomUUID(),
    });
    assert.equal(result.status, "failed");
    assert.equal(
      await db
        .prepare("SELECT canonical_name FROM knowledge_catalog_products WHERE id=1")
        .first("canonical_name"),
      "Race winner",
    );
    assert.equal(
      await db
        .prepare("SELECT canonical_model FROM knowledge_catalog_products WHERE id=1")
        .first("canonical_model"),
      "C10",
    );
    assert.equal(
      await db
        .prepare("SELECT COUNT(*) n FROM knowledge_catalog_aliases WHERE product_id=1")
        .first("n"),
      1,
    );
    assert.equal(await db.prepare("SELECT COUNT(*) n FROM admin_csv_import_changes").first("n"), 0);
  } finally {
    await dispose();
  }
}, 30_000);
