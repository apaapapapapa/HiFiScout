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
    const beforeCategories = await db
      .prepare(
        "SELECT category_id, is_direct FROM product_categories WHERE product_id = ? ORDER BY category_id",
      )
      .bind(id)
      .all();

    const measured = accountReads(db);
    await replayAdminCsvListings(measured.db, [id], "2026-09-12T09:00:00.000Z", []);

    assert.deepEqual(
      await db
        .prepare(
          "SELECT category_id, is_direct FROM product_categories WHERE product_id = ? ORDER BY category_id",
        )
        .bind(id)
        .all(),
      beforeCategories,
    );
    assert.ok(measured.rowsWritten() > 0);
    assert.ok(
      measured.rowsWritten() <= 4,
      `metadata-only replay wrote ${measured.rowsWritten()} rows`,
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
