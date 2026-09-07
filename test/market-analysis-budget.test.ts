import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database, AT } from "./helpers/d1-write-budget.js";
import { maintainMarketAnalysis, loadMarketAnalysis } from "../src/db/market-analysis-repository.js";
import { accountReads } from "../src/db/read-accounting.js";
import { deferredPriceIndexRefresh } from "../src/db/knowledge-catalog-price-index-deferred-refresh.js";

test("market reads stay bounded as catalogs and a single product's sample history grow", async () => {
  const { db, dispose } = await database();
  const costs: { size: number; reads: number; writes: number; statements: number }[] = [];
  try {
    let previous = 0;
    for (const size of [100, 10000]) {
      await db.prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
        SELECT 700000+i,'fixture','Market '||i,'MARKET'||i,?,? FROM n`).bind(previous + 1, size, AT, AT).run();
      await db.batch(deferredPriceIndexRefresh(db, `market-fixture-${size}`, [db.prepare(`
        WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO knowledge_catalog_price_index_samples(event_key,catalog_product_id,listing_product_id,shop_key,source_id,sample_kind,signal_kind,price_yen,observed_at)
        SELECT 'market:'||i,700001,i,CASE WHEN i%2=0 THEN 'a' ELSE 'b' END,'s'||i,'asking','asking',i*100,? FROM n`)
        .bind(previous + 1, size, AT)]));
      const measured = accountReads(db);
      assert.equal((await maintainMarketAnalysis(measured.db, new Date(AT))).refreshed, 1);
      const analysis = await loadMarketAnalysis(measured.db, 700001);
      assert.equal(analysis?.status, size > 500 ? "limited" : "ready");
      costs.push({ size, reads: measured.rowsRead(), writes: measured.rowsWritten(), statements: measured.statementCount() });
      assert.ok(measured.rowsRead() < 2000, JSON.stringify(costs));
      assert.ok(measured.rowsWritten() < 30 && measured.statementCount() <= 10, JSON.stringify(costs));
      const publicRead = accountReads(db);
      await loadMarketAnalysis(publicRead.db, 700001);
      assert.ok(publicRead.rowsRead() < 10);
      assert.equal(publicRead.rowsWritten(), 0);
      assert.equal(publicRead.statementCount(), 1);
      const idle = accountReads(db);
      await maintainMarketAnalysis(idle.db, new Date(AT));
      assert.equal(idle.rowsWritten(), 0);
      assert.ok(idle.rowsRead() < 20);
      previous = size;
    }
    console.log(JSON.stringify({ event: "condition_market_budget", costs }));
  } finally { await dispose(); }
}, 60_000);
