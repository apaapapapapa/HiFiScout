import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { loadCatalogRowsById } from "../src/db/catalog-lookup-candidates.js";
import { accountReads } from "../src/db/read-accounting.js";
import { localD1 } from "./helpers/local-d1.js";
import { migrationSources } from "./helpers/migrations.js";

test("catalog row loading uses point lookups as the verified catalog grows", async () => {
  const { db, dispose } = await localD1();
  try {
    for (const { sql } of migrationSources) {
      await db.prepare(sql.replace(/^\s*--[^\n]*$/gm, "")).run();
    }
    await db
      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO knowledge_catalog_products(
        id,manufacturer_id,canonical_model,normalized_model,canonical_name,
        verification_status,created_at,updated_at
      )
      SELECT 900000+i,'budget-brand','MODEL-'||i,'MODEL-'||i,'Model '||i,
        'verified','2026-09-13','2026-09-13' FROM n;
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
      SELECT id,'AMP.INTEGRATED',1 FROM knowledge_catalog_products
      WHERE manufacturer_id='budget-brand';
      INSERT INTO knowledge_catalog_aliases(product_id,alias,normalized_alias,alias_type,created_at)
      VALUES(900001,'First Model','FIRST MODEL','model','2026-09-13')`)
      .run();

    const uniqueIds = Array.from({ length: 39 }, (_, index) => 900001 + index);
    const ids = [...uniqueIds, uniqueIds[0]];
    const placeholders = ids.map(() => "?").join(",");
    const legacy = accountReads(db);
    const legacyRows = await legacy.db
      .prepare(`SELECT kp.id,kp.manufacturer_id,kp.canonical_model,kp.normalized_model,kp.canonical_name,
        kpc.category_id,kpc.is_primary FROM knowledge_catalog_products kp
        LEFT JOIN knowledge_catalog_product_categories kpc ON kpc.product_id = kp.id
        WHERE kp.verification_status = 'verified' AND kp.id IN (${placeholders})
        ORDER BY kp.id,kpc.is_primary DESC,kpc.category_id`)
      .bind(...ids)
      .all();

    const measured = accountReads(db);
    const loaded = await loadCatalogRowsById(measured.db, ids);
    assert.deepEqual(loaded.rows, legacyRows.results);
    assert.deepEqual(loaded.aliases, [
      { product_id: 900001, alias: "First Model", normalized_alias: "FIRST MODEL" },
    ]);
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(
      measured.rowsRead() < 1_000,
      `bounded reads=${measured.rowsRead()} legacy reads=${legacy.rowsRead()}`,
    );
    assert.ok(
      measured.rowsRead() * 10 < legacy.rowsRead(),
      `bounded ${measured.rowsRead()} vs legacy ${legacy.rowsRead()} reads`,
    );
    console.log(
      JSON.stringify({
        event: "catalog_row_loader_read_budget",
        legacyReads: legacy.rowsRead(),
        boundedReads: measured.rowsRead(),
        boundedWrites: measured.rowsWritten(),
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);
