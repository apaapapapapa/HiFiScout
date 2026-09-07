import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database, AT } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { updateCatalogSpecifications } from "../src/db/catalog-specification-repository.js";
import { productQuery } from "./helpers/product-query.js";

test("specification ranges use indexes and unchanged saves do not rewrite port projections", async () => {
  const { db, dispose } = await database();
  const costs: { size: number; reads: number; statements: number }[] = [];
  const specification = { widthMm: 440, heightMm: 150, depthMm: 400, weightKg: 12,
    inputs: [], outputs: [{ connector: "XLR", count: 3 }], main: [], sourceUrl: "https://example.test/official" };
  try {
    let previous = 0;
    for (const size of [100, 10000]) {
      await db.prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
        SELECT 700000+i,'fixture','Model '||i,'MODEL'||i,?,? FROM n`).bind(previous + 1, size, AT, AT).run();
      await db.prepare(`INSERT INTO product_search_entities(id,entity_key,entity_kind,catalog_product_id,model,offer_count,in_stock_offer_count,lowest_price_yen,lowest_in_stock_price_yen)
        SELECT id,'c-'||id,'catalog',id,canonical_model,1,1,id,id FROM knowledge_catalog_products WHERE id>?`).bind(700000 + previous).run();
      await db.prepare(`INSERT INTO catalog_product_specifications(catalog_product_id,specification_json,updated_at)
        SELECT id,CASE WHEN id<=700012 THEN ? ELSE json_set(?, '$.widthMm', 1000, '$.outputs[0].count', 1) END,?
        FROM knowledge_catalog_products WHERE id>?`).bind(JSON.stringify(specification), JSON.stringify(specification), AT, 700000 + previous).run();
      const measured = accountReads(db);
      const result = await searchProducts(measured.db, productQuery("?maxWidthMm=450&minXlrOutputs=3&sort=priceAsc&limit=5&includeTotal=true"));
      assert.equal(result.totalCount, 12);
      costs.push({ size, reads: measured.rowsRead(), statements: measured.statementCount() });
      assert.equal(measured.rowsWritten(), 0);
      previous = size;
    }
    assert.ok(costs[1].reads <= costs[0].reads + 20, JSON.stringify(costs));
    assert.ok(costs.every((cost) => cost.reads < 1000 && cost.statements <= 4), JSON.stringify(costs));
    const noop = accountReads(db);
    await updateCatalogSpecifications(noop.db, 700001, specification);
    assert.equal(noop.rowsWritten(), 0);
    assert.ok(noop.rowsRead() < 30);
    console.log(JSON.stringify({ event: "specification_search_budget", costs, noopReads: noop.rowsRead(), noopWrites: noop.rowsWritten() }));
  } finally { await dispose(); }
}, 60_000);
