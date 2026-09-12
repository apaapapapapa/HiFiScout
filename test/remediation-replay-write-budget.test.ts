import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { RESOLUTION_VERSIONS } from "../src/catalog/resolution-versions.js";
import { replayAdminCsvListings } from "../src/db/data-quality-remediation-service.js";
import { refreshListingProjections } from "../src/db/listing-projection-refresh.js";
import { accountReads } from "../src/db/read-accounting.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { AT, database, listing } from "./helpers/d1-write-budget.js";

test("metadata-only remediation does not rewrite unrelated listing indexes or categories", async () => {
  const { db, dispose } = await database();
  try {
    const product = listing("metadata-only");
    await upsertProducts(db, "budget", [product], AT);
    await refreshListingProjections(db, [{ shop_key: "budget", source_id: product.sourceId }], AT);
    const id = Number(
      await db
        .prepare("SELECT id FROM products WHERE shop_key = ? AND source_id = ?")
        .bind("budget", product.sourceId)
        .first("id"),
    );
    await db
      .prepare(
        "UPDATE products SET metadata_json = json_set(metadata_json, '$.categoryClassification.version', ?) WHERE id = ?",
      )
      .bind(RESOLUTION_VERSIONS.category - 1, id)
      .run();
    const beforeCategories = (
      await db
        .prepare(
          "SELECT category_id, is_direct FROM product_categories WHERE product_id = ? ORDER BY category_id",
        )
        .bind(id)
        .all()
    ).results;

    const measured = accountReads(db);
    await replayAdminCsvListings(measured.db, [id], "2026-09-12T09:00:00.000Z", []);

    assert.deepEqual(
      (
        await db
          .prepare(
            "SELECT category_id, is_direct FROM product_categories WHERE product_id = ? ORDER BY category_id",
          )
          .bind(id)
          .all()
      ).results,
      beforeCategories,
    );
    assert.ok(measured.rowsWritten() > 0);
    assert.ok(
      measured.rowsWritten() <= 4,
      `metadata-only replay wrote ${measured.rowsWritten()} rows`,
    );
    assert.ok(
      measured.rowsRead() <= 35,
      `metadata-only replay read ${measured.rowsRead()} rows without changing a projection`,
    );
    assert.equal(
      await db
        .prepare("SELECT remediation_projection_required FROM products WHERE id = ?")
        .bind(id)
        .first("remediation_projection_required"),
      0,
    );
    console.log(
      JSON.stringify({
        event: "remediation_metadata_only_write_budget",
        rowsRead: measured.rowsRead(),
        rowsWritten: measured.rowsWritten(),
        statements: measured.countedStatements(),
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);

test("metadata-only remediation still finishes a projection marker owned by an older writer", async () => {
  const { db, dispose } = await database();
  try {
    const product = listing("metadata-only-pending");
    await upsertProducts(db, "budget", [product], AT);
    await refreshListingProjections(db, [{ shop_key: "budget", source_id: product.sourceId }], AT);
    const id = Number(
      await db
        .prepare("SELECT id FROM products WHERE shop_key = ? AND source_id = ?")
        .bind("budget", product.sourceId)
        .first("id"),
    );
    await db
      .prepare(`UPDATE products
        SET metadata_json = json_set(metadata_json, '$.categoryClassification.version', ?),
            remediation_projection_required = 1,
            remediation_projection_token = 'older-writer'
        WHERE id = ?`)
      .bind(RESOLUTION_VERSIONS.category - 1, id)
      .run();
    await db.prepare("DELETE FROM product_search_projection WHERE product_id = ?").bind(id).run();

    await replayAdminCsvListings(db, [id], "2026-09-12T09:00:00.000Z", []);

    assert.ok(
      await db
        .prepare("SELECT product_id FROM product_search_projection WHERE product_id = ?")
        .bind(id)
        .first(),
    );
    assert.deepEqual(
      await db
        .prepare(
          "SELECT remediation_projection_required AS pending, remediation_projection_token AS token FROM products WHERE id = ?",
        )
        .bind(id)
        .first(),
      { pending: 0, token: "" },
    );
  } finally {
    await dispose();
  }
}, 30_000);
