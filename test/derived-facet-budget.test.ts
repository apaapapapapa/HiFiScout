import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { database, AT } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import { syncAutomaticFacetFacts } from "../src/db/derived-facet-repository.js";
import { verifiedModelFacetFacts } from "../src/catalog/verified-model-facets.js";

test("automatic facet replay stays bounded and leaves equal decisions and manual facts untouched", async () => {
  const { db, dispose } = await database();
  const costs: { size: number; reads: number; writes: number; statements: number }[] = [];
  try {
    let previous = 0;
    const facts = verifiedModelFacetFacts({
      manufacturerId: "bowers-wilkins",
      model: "805D4",
      title: "B&W 805D4",
      primaryCategoryId: "SPK.LOUDSPEAKER",
    });
    for (const size of [100, 10000]) {
      await db
        .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at)
        SELECT i,'shop',CAST(i AS TEXT),'Speaker','https://example.test/'||i,'${AT}','${AT}','${AT}' FROM n`)
        .bind(previous + 1, size)
        .run();
      await db
        .prepare(`INSERT INTO product_facet_facts(product_id,facet_id,facet_value,source,confidence,verified_at)
        SELECT id,'use_case','home','manual',1,'${AT}' FROM products WHERE id>?`)
        .bind(previous)
        .run();
      await db
        .prepare(
          "DELETE FROM product_facet_facts WHERE product_id=1 AND source LIKE 'verified_model:%'",
        )
        .run();
      const measured = accountReads(db);
      await syncAutomaticFacetFacts(measured.db, 1, facts);
      costs.push({
        size,
        reads: measured.rowsRead(),
        writes: measured.rowsWritten(),
        statements: measured.statementCount(),
      });
      const unchanged = accountReads(db);
      await syncAutomaticFacetFacts(unchanged.db, 1, facts);
      assert.equal(unchanged.rowsWritten(), 0);
      const manual = await db
        .prepare(
          "SELECT verified_at FROM product_facet_facts WHERE product_id=1 AND source='manual'",
        )
        .first<{ verified_at: string }>();
      assert.equal(manual?.verified_at, AT);
      previous = size;
    }
    assert.ok(costs[1].reads <= costs[0].reads + 10, JSON.stringify(costs));
    assert.ok(
      costs.every((c) => c.reads < 100 && c.writes < 10 && c.statements === 2),
      JSON.stringify(costs),
    );
    console.log(JSON.stringify({ event: "derived_facet_replay_budget", costs }));
  } finally {
    await dispose();
  }
}, 30000);
