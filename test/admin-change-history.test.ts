import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { readAdminChangeHistory } from "../src/db/admin-change-history-repository.js";
import {
  parseAdminRestoreSelection,
  previewAdminHistoryRestore,
  restoreAdminHistoryColor,
} from "../src/admin/change-history.js";
import { updateListingAdminProduct } from "../src/db/listing-admin-repository.js";
import { updateKnowledgeCatalogAdminProduct } from "../src/db/knowledge-catalog-admin-repository.js";
import { applyAdminCsvChange } from "../src/db/admin-csv-import-repository.js";

function seed() {
  const context = migratedSqlite();
  context.sqlite
    .exec(`INSERT INTO products(id, shop_key, source_id, title, source_url, first_seen_at,
    last_seen_at, last_changed_at, canonical_manufacturer_id, manufacturer_id, manufacturer,
    raw_manufacturer, raw_model, model, normalized_model, presentation_color)
    VALUES (100001, 'test', 'history', 'Seller original title', 'https://example.test/history', '', '', '',
    'luxman', 'luxman', 'LUXMAN', 'LUXMAN', 'M-1', 'M-1', 'M1', 'シルバー')`);
  return context;
}

test("editor history and guarded restoration keep seller evidence and reuse CSV receipts", async () => {
  const { db, sqlite } = seed();
  try {
    await updateListingAdminProduct(db, 100001, { model: "M-2" }, "2026-09-01T00:00:00Z");
    const history = await readAdminChangeHistory(db, "listing", 100001);
    const edit = history.items.find((row) => row.source === "editor")!;
    assert.equal(edit.before.model, "M-1");
    assert.equal(edit.after.model, "M-2");
    const selection = {
      kind: "listing",
      targetId: 100001,
      source: "editor",
      operationId: edit.operationId,
      field: "model",
    } as const;
    const preview = await previewAdminHistoryRestore(db, selection);
    assert.equal(preview.status, "ready");
    assert.ok("change" in preview && preview.change && preview.revision);
    const input = {
      change: preview.change,
      revision: preview.revision,
      operationId: crypto.randomUUID(),
    };
    assert.equal((await applyAdminCsvChange(db, input)).status, "applied");
    assert.equal((await applyAdminCsvChange(db, input)).status, "applied");
    const row = sqlite
      .prepare("SELECT model, raw_model, title FROM products WHERE id = 100001")
      .get();
    assert.equal(row?.model, "M-1");
    assert.equal(row?.raw_model, "M-1");
    assert.equal(row?.title, "Seller original title");
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM admin_product_change_log").get()?.n,
      1,
      "CSV does not duplicate the editor journal",
    );
    assert.equal((await previewAdminHistoryRestore(db, selection)).status, "conflict");
  } finally {
    sqlite.close();
  }
});

test("same-value replay has no writes and later ABA edits prevent restoration", async () => {
  const { db, sqlite } = seed();
  try {
    await updateListingAdminProduct(
      db,
      100001,
      { presentationColor: "ブラック" },
      "2026-09-01T00:00:00Z",
    );
    const edit = (await readAdminChangeHistory(db, "listing", 100001)).items.find(
      (row) => row.source === "editor",
    )!;
    const changes = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    await updateListingAdminProduct(db, 100001, { presentationColor: "ブラック" });
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changes);
    await updateListingAdminProduct(
      db,
      100001,
      { presentationColor: "シルバー" },
      "2026-09-02T00:00:00Z",
    );
    await updateListingAdminProduct(
      db,
      100001,
      { presentationColor: "ブラック" },
      "2026-09-03T00:00:00Z",
    );
    assert.equal(
      (
        await previewAdminHistoryRestore(db, {
          kind: "listing",
          targetId: 100001,
          source: "editor",
          operationId: edit.operationId,
          field: "presentation_color",
        })
      ).status,
      "conflict",
    );
  } finally {
    sqlite.close();
  }
});

test("colour restore is idempotent and never overwrites a later edit", async () => {
  const { db, sqlite } = seed();
  try {
    await updateListingAdminProduct(
      db,
      100001,
      { presentationColor: "ブラック" },
      "2026-09-01T00:00:00Z",
    );
    const edit = (await readAdminChangeHistory(db, "listing", 100001)).items.find(
      (row) => row.source === "editor",
    )!;
    const selection = {
      kind: "listing",
      targetId: 100001,
      source: "editor",
      operationId: edit.operationId,
      field: "presentation_color",
    } as const;
    const preview = await previewAdminHistoryRestore(db, selection);
    assert.equal(preview.status, "ready");
    assert.ok("revision" in preview && preview.revision);
    const operation = crypto.randomUUID();
    assert.equal(
      (await restoreAdminHistoryColor(db, selection, preview.revision, operation)).status,
      "applied",
    );
    assert.equal(
      sqlite.prepare("SELECT presentation_color FROM products WHERE id = 100001").get()
        ?.presentation_color,
      "シルバー",
    );
    await updateListingAdminProduct(db, 100001, { presentationColor: "ゴールド" });
    await restoreAdminHistoryColor(db, selection, preview.revision, operation);
    assert.equal(
      sqlite.prepare("SELECT presentation_color FROM products WHERE id = 100001").get()
        ?.presentation_color,
      "ゴールド",
    );
  } finally {
    sqlite.close();
  }
});

test("catalogue name history supports a field restore without rewriting the manufacturer", async () => {
  const { db, sqlite } = seed();
  try {
    sqlite.exec(`INSERT INTO knowledge_catalog_products(id, manufacturer_id, canonical_model, normalized_model,
      canonical_name, verification_status, lifecycle_status, created_at, updated_at)
      VALUES (100001, 'luxman', 'M-1', 'M1', 'LUXMAN M-1', 'verified', 'unknown', '2026-01-01', '2026-01-01');
      INSERT INTO knowledge_catalog_product_categories(product_id, category_id, is_primary) VALUES (100001, 'AMP.POWER', 1);`);
    await updateKnowledgeCatalogAdminProduct(
      db,
      100001,
      {
        canonicalName: "LUXMAN M-1 edited",
        lifecycleStatus: "unknown",
        primaryCategoryId: "AMP.POWER",
      },
      "2026-09-01T00:00:00Z",
    );
    const edit = (await readAdminChangeHistory(db, "catalog", 100001)).items[0];
    // Routine remediation changes storage timestamps without creating a new admin decision.
    sqlite.exec(`UPDATE knowledge_catalog_products SET remediation_after_listing_id = 123,
      last_remediated_at = '2026-09-02T00:00:00Z', updated_at = '2026-09-02T00:00:00Z'
      WHERE id = 100001`);
    const preview = await previewAdminHistoryRestore(db, {
      kind: "catalog",
      targetId: 100001,
      source: "editor",
      operationId: edit.operationId,
      field: "canonical_name",
    });
    assert.equal(preview.status, "ready");
    assert.ok("change" in preview && preview.change);
    assert.equal(preview.change.values.manufacturer_id, "luxman");
    assert.equal(preview.change.values.canonical_name, "LUXMAN M-1");
    sqlite.exec(
      "UPDATE knowledge_catalog_products SET last_reviewed_at = '2026-09-03T00:00:00Z' WHERE id = 100001",
    );
    assert.equal(
      (
        await previewAdminHistoryRestore(db, {
          kind: "catalog",
          targetId: 100001,
          source: "editor",
          operationId: edit.operationId,
          field: "canonical_name",
        })
      ).status,
      "conflict",
      "a later review still conflicts even if values match",
    );
  } finally {
    sqlite.close();
  }
});

test("history restore rejects arbitrary target kinds, fields and malformed IDs", () => {
  assert.equal(
    parseAdminRestoreSelection({
      kind: "listing",
      targetId: 1,
      source: "editor",
      operationId: crypto.randomUUID(),
      field: "price_yen",
    }),
    null,
  );
  assert.equal(
    parseAdminRestoreSelection({
      kind: "catalog",
      targetId: -1,
      source: "editor",
      operationId: crypto.randomUUID(),
      field: "canonical_name",
    }),
    null,
  );
});

test("a concurrent edit aborts the journal and override in the same transaction", async () => {
  const { db, sqlite } = seed();
  try {
    const concurrent = {
      prepare: db.prepare.bind(db),
      async batch<T = unknown>(statements: D1PreparedStatement[]) {
        sqlite.exec("UPDATE products SET model = 'Concurrent model' WHERE id = 100001");
        return db.batch<T>(statements);
      },
    };
    await assert.rejects(
      updateListingAdminProduct(concurrent, 100001, { model: "M-2" }),
      /malformed JSON/u,
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM admin_product_change_log").get()?.n, 0);
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM product_admin_overrides WHERE listing_product_id=100001",
        )
        .get()?.n,
      0,
    );
    assert.equal(
      sqlite.prepare("SELECT model FROM products WHERE id=100001").get()?.model,
      "Concurrent model",
    );
  } finally {
    sqlite.close();
  }
});
