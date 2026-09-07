import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { database, AT } from "./helpers/d1-write-budget.js";
import { accountReads } from "../src/db/read-accounting.js";
import { listModelFacts, saveModelFact } from "../src/db/model-relation-repository.js";
import type { ModelFactInput } from "../src/catalog/model-relations.js";

test("model fact reads and guarded writes do not scan unrelated relationships", async () => {
  const { db, dispose } = await database();
  const costs: { size: number; reads: number; writes: number; statements: number }[] = [];
  try {
    await db.prepare(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
      VALUES(700001,'budget','A','A',?,?),(700002,'budget','B','B',?,?)`).bind(AT,AT,AT,AT).run();
    const input: ModelFactInput = { kind: "successor", relatedProductId: 700002, familyName: "", position: null, state: "verified", sourceId: null, manualNote: "Manually verified official model succession.", manufacturerJustification: "" };
    const first = (await saveModelFact(db, 700001, input, { actor: "budget-test" }, AT))!;
    let previous = 0;
    for (const size of [100, 10000]) {
      await db.prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<=?)
        INSERT OR IGNORE INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,created_at,updated_at)
        SELECT 800000+i,'fixture','MODEL'||i,'MODEL'||i,?,? FROM n`).bind(previous+1,size,AT,AT).run();
      await db.prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO knowledge_catalog_model_facts(id,product_id,related_product_id,relation_type,state,evidence_kind,data_json,updated_at,audit_actor)
        SELECT 'fixture-'||i,800000+i,800001+i,'variant','candidate','manual','{}',?,'fixture' FROM n`).bind(previous+1,size,AT).run();
      const measured = accountReads(db);
      assert.equal((await listModelFacts(measured.db, 700001, AT)).length, 1);
      await saveModelFact(measured.db, 700001, input, { id: first.id, expectedVersion: 1, actor: "budget-test" }, AT);
      costs.push({ size, reads: measured.rowsRead(), writes: measured.rowsWritten(), statements: measured.statementCount() });
      previous = size;
    }
    assert.ok(costs[1].reads <= costs[0].reads + 20, JSON.stringify(costs));
    assert.ok(costs.every((cost) => cost.reads < 100 && cost.writes === 0 && cost.statements <= 4), JSON.stringify(costs));
    const measured = accountReads(db);
    await saveModelFact(measured.db, 700001, { ...input, state: "candidate" }, { id: first.id, expectedVersion: 1, actor: "budget-test" }, AT);
    assert.ok(measured.rowsRead() < 200 && measured.rowsWritten() < 50, JSON.stringify({ reads: measured.rowsRead(), writes: measured.rowsWritten() }));
    console.log(JSON.stringify({ event: "model_relation_budget", costs, changedReads: measured.rowsRead(), changedWrites: measured.rowsWritten() }));
  } finally { await dispose(); }
}, 60_000);
