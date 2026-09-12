import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database, AT, NEXT } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import { saveSellerDetailOfferFacts } from "../src/db/seller-detail-offer-repository.js";
import { sellerOfferFactWrites } from "../src/db/offer-fact-repository.js";
import type { OfferFact } from "../src/catalog/types.js";

test("one listing's detail facts stay bounded as retained inventory grows", async () => {
  const { db, dispose } = await database();
  const costs: { size: number; reads: number; writes: number; statements: number }[] = [];
  const facts: OfferFact[] = [
    {
      factId: "shop_warranty",
      state: "present",
      source: "seller_detail",
      sourceField: "detail_warranty",
      ruleId: "audiounion.detail.v1.shop_warranty",
      confidence: 1,
      observedAt: AT,
      warrantyMonths: 6,
    },
  ];
  try {
    let previous = 0;
    for (const size of [100, 10000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at)
        SELECT i,'shop',CAST(i AS TEXT),'Amp','https://example.test/'||i,'${AT}','${AT}','${AT}' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`INSERT INTO product_offer_facts(product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at)
        SELECT id,'remote_control','manual','unknown','manual','fixture',1,'${AT}' FROM products WHERE id>?`)
        .bind(previous)
        .run();
      await saveSellerDetailOfferFacts(db, 1, []);
      const measured = accountReads(db);
      await saveSellerDetailOfferFacts(measured.db, 1, facts);
      costs.push({
        size,
        reads: measured.rowsRead(),
        writes: measured.rowsWritten(),
        statements: measured.statementCount(),
      });
      const unchanged = accountReads(db);
      await saveSellerDetailOfferFacts(
        unchanged.db,
        1,
        facts.map((f) => ({ ...f, observedAt: NEXT })),
      );
      assert.equal(unchanged.rowsWritten(), 0);
      const list = accountReads(db);
      await list.db.batch(sellerOfferFactWrites(list.db, "shop", "1", "Amp", "リモコンあり", NEXT));
      assert.ok(
        list.rowsRead() < 100 && list.rowsWritten() < 10,
        JSON.stringify({ reads: list.rowsRead(), writes: list.rowsWritten() }),
      );
      previous = size;
    }
    assert.ok(costs[1].reads <= costs[0].reads + 10, JSON.stringify(costs));
    assert.ok(
      costs.every((c) => c.reads < 100 && c.writes < 10 && c.statements === 2),
      JSON.stringify(costs),
    );
    console.log(JSON.stringify({ event: "seller_detail_offer_budget", costs }));
  } finally {
    await dispose();
  }
}, 30000);
