import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { database, AT } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import { stepOfferFactReplay } from "../src/db/offer-fact-replay-repository.js";

test("replay reads and writes a bounded prefix as the retained inventory grows", async () => {
  const { db, dispose } = await database();
  const costs: { size: number; reads: number; writes: number; statements: number }[] = [];
  try {
    let previous = 0;
    for (const size of [100, 10000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (
        SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,condition_text,source_url,first_seen_at,last_seen_at,last_changed_at)
        SELECT i,'shop',CAST(i AS TEXT),'Amp A1','元箱あり','https://example.test/'||i,'${AT}','${AT}','${AT}' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db.prepare("DELETE FROM product_offer_fact_replays").run();
      const measured = accountReads(db);
      const result = await stepOfferFactReplay(measured.db);
      assert.equal(result?.scannedCount, 25);
      costs.push({
        size,
        reads: measured.rowsRead(),
        writes: measured.rowsWritten(),
        statements: measured.statementCount(),
      });
      previous = size;
    }
    assert.ok(costs[1].reads <= costs[0].reads + 100, JSON.stringify(costs));
    assert.ok(
      costs.every((cost) => cost.reads < 1000 && cost.writes < 200 && cost.statements <= 60),
      JSON.stringify(costs),
    );
    console.log(JSON.stringify({ event: "offer_fact_replay_budget", costs }));
  } finally {
    await dispose();
  }
});
