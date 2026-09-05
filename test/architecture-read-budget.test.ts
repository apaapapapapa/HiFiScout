import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { localD1 } from "./helpers/local-d1.js";
import { accountReads } from "../src/db/read-accounting.js";
import { repairActiveListingProjectionGaps } from "../src/db/product-search-gap-repair.js";
import { findVerifiedCatalogMatches } from "../src/db/knowledge-catalog-repository.js";
import { syncProductIdentityResolutions } from "../src/db/product-identity-repository.js";

test("healthy audit and exact model lookup stay bounded as unrelated same-brand data grows", async () => {
  const { db, dispose } = await localD1();
  try {
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      await db
        .prepare(readFileSync(new URL(name, directory), "utf8").replace(/^\s*--[^\n]*$/gm, ""))
        .run();
    }
    await db
      .prepare(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
      VALUES(900000,'marantz','MODEL 10','MODEL 10','Marantz MODEL 10','2026-09-05','2026-09-05');
      INSERT INTO knowledge_catalog_product_categories(product_id,category_id,is_primary) VALUES(900000,'AMP.INTEGRATED',1);
      INSERT INTO product_search_entities(entity_key,entity_kind,catalog_product_id,manufacturer_id,model)
      VALUES('c-900000','catalog',900000,'marantz','MODEL 10');`)
      .run();
    const entity = await db
      .prepare("SELECT id FROM product_search_entities WHERE entity_key='c-900000'")
      .first<{ id: number }>();
    assert.ok(entity);
    const costs: { size: number; audit: number; lookup: number }[] = [];
    let previous = 0;
    for (const size of [100, 1000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,canonical_manufacturer_id,model,model_resolution_status,title,source_url,first_seen_at,last_seen_at,last_changed_at)
        SELECT i,'cost',CAST(i AS TEXT),'marantz','MODEL10/FB','resolved','MODEL10/FB','https://example.test/cost','2026-09-05','2026-09-05','2026-09-05' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`INSERT INTO product_identity_resolutions(listing_product_id,catalog_product_id,status,match_method,confidence,evaluated_at)
        SELECT id,900000,'matched','catalog_alias','high','2026-09-05' FROM products WHERE id>?`)
        .bind(previous)
        .run();
      await db
        .prepare(`INSERT INTO product_search_entity_offers(listing_product_id,entity_id,shop_key)
        SELECT id,?,'cost' FROM products WHERE id>?`)
        .bind(entity.id, previous)
        .run();
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
        SELECT 900000+i,'marantz','UNRELATED-'||i,'UNRELATED-'||i,'Unrelated','2026-09-05','2026-09-05' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db.prepare("DELETE FROM listing_projection_pending").run();
      await db.prepare("DELETE FROM product_projection_audit_cursors").run();
      const audit = accountReads(db);
      const result = await repairActiveListingProjectionGaps(audit.db, {
        phases: "coverage",
        batchSize: 5,
        maxListings: 20,
        maxScannedListings: 25,
      });
      assert.equal(result.selectedCount, 0);
      assert.equal(result.scannedCount, 50);
      assert.ok(audit.rowsRead() < 400, `healthy ${size}: ${audit.rowsRead()} reads`);
      const lookup = accountReads(db);
      const found = await findVerifiedCatalogMatches(lookup.db, [
        { manufacturerId: "marantz", model: "MODEL10/FB", modelResolutionStatus: "resolved" },
      ]);
      assert.equal(found.get("marantz:MODEL10/FB")?.id, 900000);
      await syncProductIdentityResolutions(lookup.db, "cost", ["1"]);
      assert.ok(lookup.rowsRead() < 100, `exact ${size}: ${lookup.rowsRead()} reads`);
      costs.push({ size, audit: audit.rowsRead(), lookup: lookup.rowsRead() });
      previous = size;
    }
    assert.equal(costs[0].audit, costs[1].audit);
    assert.ok(costs[1].lookup <= costs[0].lookup + 2);
    console.log(JSON.stringify({ event: "architecture_read_budget", costs }));
  } finally {
    await dispose();
  }
}, 30000);
