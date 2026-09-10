import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { knowledgeCatalogKey } from "../src/catalog/knowledge-catalog.js";
import { findManualVerifiedCategoryMatches } from "../src/db/manual-category-authority-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { localD1 } from "./helpers/local-d1.js";
import { migrationSources } from "./helpers/migrations.js";

test("manual category authority reads only requested models as a manufacturer catalog grows", async () => {
  const { db, dispose } = await localD1();
  try {
    for (const { sql } of migrationSources) {
      await db.prepare(sql.replace(/^\s*--[^\n]*$/gm, "")).run();
    }
    await db
      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1001)
      INSERT INTO knowledge_catalog_products(
        id,manufacturer_id,canonical_model,normalized_model,canonical_name,
        verification_status,created_at,updated_at
      )
      SELECT 800000+i,'budget-brand',
        CASE WHEN i=1 THEN 'TARGET-1' ELSE 'UNRELATED-'||i END,
        CASE WHEN i=1 THEN 'TARGET-1' ELSE 'UNRELATED-'||i END,
        CASE WHEN i=1 THEN 'Target One' ELSE 'Unrelated' END,
        'verified','2026-09-10','2026-09-10' FROM n;
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
      SELECT id,'AMP.INTEGRATED',1 FROM knowledge_catalog_products
      WHERE manufacturer_id='budget-brand';
      INSERT INTO knowledge_catalog_sources(
        product_id,source_type,source_url,status,created_at,updated_at
      )
      SELECT id,'manual_verified','manual://budget/'||id,'active','2026-09-10','2026-09-10'
      FROM knowledge_catalog_products WHERE manufacturer_id='budget-brand';
      INSERT INTO knowledge_catalog_aliases(product_id,alias,normalized_alias,alias_type,created_at)
      VALUES(800001,'Target One Alias','TARGET ONE ALIAS','model','2026-09-10')`)
      .run();

    const legacy = accountReads(db);
    const legacyRows = await legacy.db
      .prepare(`SELECT DISTINCT kp.id, kp.manufacturer_id, kp.canonical_model,
        kp.normalized_model, kp.canonical_name, kpc.category_id
      FROM knowledge_catalog_products kp
      JOIN knowledge_catalog_sources s
        ON s.product_id=kp.id AND s.source_type='manual_verified' AND s.status='active'
      JOIN knowledge_catalog_product_categories kpc
        ON kpc.product_id=kp.id AND kpc.is_primary=1
      WHERE kp.verification_status='verified' AND kp.manufacturer_id IN (?)
      ORDER BY kp.id`)
      .bind("budget-brand")
      .all();
    assert.equal(legacyRows.results?.length, 1001);

    const measured = accountReads(db);
    const matches = await findManualVerifiedCategoryMatches(measured.db, [
      {
        manufacturerId: "budget-brand",
        model: "TARGET-1",
        modelResolutionStatus: "candidate",
      },
      {
        manufacturerId: "budget-brand",
        model: "Target One Alias",
        modelResolutionStatus: "candidate",
      },
    ]);
    assert.equal(matches.get(knowledgeCatalogKey("budget-brand", "TARGET-1"))?.id, 800001);
    assert.equal(matches.get(knowledgeCatalogKey("budget-brand", "Target One Alias"))?.id, 800001);
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(
      measured.rowsRead() < 100,
      `bounded reads=${measured.rowsRead()} legacy reads=${legacy.rowsRead()}`,
    );
    assert.ok(
      measured.rowsRead() * 20 < legacy.rowsRead(),
      `bounded ${measured.rowsRead()} vs legacy ${legacy.rowsRead()} reads`,
    );
    console.log(
      JSON.stringify({
        event: "manual_category_authority_read_budget",
        legacyReads: legacy.rowsRead(),
        boundedReads: measured.rowsRead(),
        boundedWrites: measured.rowsWritten(),
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);
