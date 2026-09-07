import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { parseModelFactWrite } from "../src/http/model-fact-admin.js";
import { handleAuthenticatedCatalogAdminRequest } from "../src/admin/index.js";
import { readModelFactsAdmin, saveModelFactsAdmin } from "../src/db/model-fact-admin-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import type { ModelFactWriteInput } from "../src/catalog/types.js";

const write: ModelFactWriteInput = { id: null, expectedVersion: null, reverify: false, fact: { kind: "successor", relatedProductId: 700002, familyName: "", position: null, state: "verified", sourceId: null, manualNote: "公式資料で後継機種の関係を確認しました。", manufacturerJustification: "" } };

test("admin model writes require bounded JSON, optimistic versions and same-origin requests", async () => {
  let writes = 0;
  const env = { CATALOG_ADMIN: {
    getModelFacts: async () => ({ facts: [] }),
    saveModelFacts: async (_id: number, input: ModelFactWriteInput, actor: string) => { writes++; assert.deepEqual(input, write); assert.equal(actor, "access_admin"); return {}; },
  } } as unknown as Parameters<typeof handleAuthenticatedCatalogAdminRequest>[1];
  const url = "https://admin.example.test/api/admin/knowledge-catalog/products/700001/model-facts";
  const request = (body: unknown, origin = "https://admin.example.test") => handleAuthenticatedCatalogAdminRequest(new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  assert.equal((await handleAuthenticatedCatalogAdminRequest(new Request(url), env)).status, 200);
  for (const body of [{ ...write, actor: "forged" }, { ...write, expectedVersion: 1 }, { ...write, id: "unknown" }, { ...write, reverify: "true" }]) {
    assert.equal(parseModelFactWrite(body), null);
    assert.equal((await request(body)).status, 400);
  }
  assert.equal((await request(write, "https://unrelated.test")).status, 403);
  assert.equal((await request({ ...write, padding: "x".repeat(8192) })).status, 413);
  assert.equal(writes, 0);
  assert.equal((await request(write)).status, 200);
  assert.equal(writes, 1);
});

test("admin snapshots preserve sourced decisions, versions, audit and removal", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
      VALUES(700001,'test','A','A','Model A','2026-09-07','2026-09-07'),(700002,'test','B','B','Model B','2026-09-07','2026-09-07');`);
    assert.equal(await readModelFactsAdmin(db, 799999), null);
    const result = (await saveModelFactsAdmin(db, 700001, write, "reviewer-subject"))!;
    assert.equal(result.product.name, "Model A");
    assert.equal(result.facts[0].relatedProductName, "Model B");
    assert.equal(result.facts[0].reviewState, "verified");
    assert.equal(result.audits[0].actor, "reviewer-subject");
    const inverse = (await readModelFactsAdmin(db, 700002))!;
    assert.equal(inverse.facts[0].productName, "Model A");
    const removed = (await saveModelFactsAdmin(db, 700002, { ...write, id: result.facts[0].id, expectedVersion: 1, fact: { ...write.fact, state: "removed" } }, "reviewer-subject"))!;
    assert.equal(removed.facts.length, 0);
    assert.equal(removed.audits.length, 2);
    await assert.rejects(saveModelFactsAdmin(db, 700001, { ...write, id: result.facts[0].id, expectedVersion: 1 }, "reviewer-subject"), /conflict/);
  } finally { sqlite.close(); }
});
