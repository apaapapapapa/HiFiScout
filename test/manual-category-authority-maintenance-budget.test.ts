import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { loadManualCategoryAuthorityTargets } from "../scripts/apply-manual-category-authority.js";
import { accountReads } from "../src/db/read-accounting.js";
import { localD1 } from "./helpers/local-d1.js";
import { migrationSources } from "./helpers/migrations.js";

const AUDIT_SOURCE = "manual://approved-category-audit/2026-08-19";

test("manual category maintenance seeks audited models instead of scanning unrelated listings", async () => {
  const { db, dispose } = await localD1();
  try {
    for (const { sql } of migrationSources) {
      await db.prepare(sql.replace(/^\s*--[^\n]*$/gm, "")).run();
    }
    await db.batch([
      db.prepare(`
        INSERT INTO knowledge_catalog_products(
          id,manufacturer_id,canonical_model,normalized_model,canonical_name,
          verification_status,created_at,updated_at
        ) VALUES(980001,'budget-brand','TARGET-1','TARGET-1','Target One',
          'verified','2026-09-10','2026-09-10')
      `),
      db.prepare(`
        INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary)
        VALUES(980001,'AMP.INTEGRATED',1)
      `),
      db
        .prepare(`
        INSERT INTO knowledge_catalog_sources(
          product_id,source_type,source_url,status,created_at,updated_at
        ) VALUES(980001,'manual_verified',?,'active','2026-09-10','2026-09-10');
      `)
        .bind(AUDIT_SOURCE),
      db.prepare(`
        INSERT INTO knowledge_catalog_aliases(product_id,alias,normalized_alias,alias_type,created_at)
        VALUES(980001,'TARGET ONE ALIAS','TARGET ONE ALIAS','model','2026-09-10')
      `),
    ]);
    await db
      .prepare(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
        INSERT INTO products(
          id,shop_key,source_id,title,manufacturer,model,source_url,
          first_seen_at,last_seen_at,last_changed_at,is_active,
          canonical_manufacturer_id,model_resolution_status
        )
        SELECT 900000+i,'budget-shop','unrelated-'||i,'Unrelated '||i,'Unrelated',
          'UNRELATED-'||i,'https://example.test/unrelated/'||i,
          '2026-09-10','2026-09-10','2026-09-10',1,'unrelated-brand','candidate'
        FROM n
      `)
      .run();
    await db
      .prepare(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
        INSERT INTO knowledge_catalog_sources(
          product_id,source_type,source_url,status,created_at,updated_at
        )
        SELECT 980001,'trusted_catalog','https://example.test/source/'||i,'active',
          '2026-09-10','2026-09-10'
        FROM n
      `)
      .run();
    await db
      .prepare(`
        INSERT INTO products(
          id,shop_key,source_id,title,manufacturer,model,source_url,
          first_seen_at,last_seen_at,last_changed_at,is_active,
          canonical_manufacturer_id,model_resolution_status
        ) VALUES
          (990001,'budget-shop','target-exact','Target One','Budget','TARGET-1',
            'https://example.test/target-exact','2026-09-10','2026-09-10','2026-09-10',
            1,'budget-brand','candidate'),
          (990002,'budget-shop','target-alias','Target Alias','Budget','TARGET ONE ALIAS',
            'https://example.test/target-alias','2026-09-10','2026-09-10','2026-09-10',
            1,'budget-brand','candidate')
      `)
      .run();
    await db.prepare("ANALYZE").run();

    const legacy = accountReads(db);
    const legacyResult = await legacy.db
      .prepare(`
        SELECT DISTINCT p.id
        FROM products p
        JOIN knowledge_catalog_products kp
          ON kp.manufacturer_id = p.canonical_manufacturer_id
         AND kp.verification_status = 'verified'
        JOIN knowledge_catalog_sources s
          ON s.product_id = kp.id
         AND s.source_type = 'manual_verified'
         AND s.source_url IN (?, ?)
         AND s.status = 'active'
        JOIN knowledge_catalog_product_categories kpc
          ON kpc.product_id = kp.id AND kpc.is_primary = 1
        LEFT JOIN knowledge_catalog_aliases ka
          ON ka.product_id = kp.id AND ka.alias_type = 'model'
        WHERE p.is_active = 1
          AND p.model_resolution_status <> 'resolved'
          AND (p.model = kp.canonical_model OR p.model = ka.alias)
        ORDER BY p.id
      `)
      .bind(AUDIT_SOURCE, "manual://approved-product-audit/2026-08-21")
      .all();
    assert.deepEqual(
      (legacyResult.results || []).map((row) => Number(row.id)),
      [990001, 990002],
    );

    const measured = accountReads(db);
    const targets = await loadManualCategoryAuthorityTargets(measured.db);
    assert.deepEqual(
      targets.map((target) => target.id),
      [990001, 990002],
    );
    assert.equal(measured.rowsWritten(), 0);
    assert.ok(
      measured.rowsRead() < 1_000,
      `bounded reads=${measured.rowsRead()} legacy reads=${legacy.rowsRead()}`,
    );
    assert.ok(
      measured.rowsRead() * 20 < legacy.rowsRead(),
      `bounded ${measured.rowsRead()} vs legacy ${legacy.rowsRead()} reads`,
    );
    console.log(
      JSON.stringify({
        event: "manual_category_authority_maintenance_read_budget",
        legacyReads: legacy.rowsRead(),
        boundedReads: measured.rowsRead(),
        boundedWrites: measured.rowsWritten(),
      }),
    );
  } finally {
    await dispose();
  }
}, 30_000);
