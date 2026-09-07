import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { parseModelFactInput } from "../src/catalog/model-relations.js";
import type { ModelFactInput } from "../src/catalog/model-relations.js";
import {
  listModelFacts,
  readModelFact,
  saveModelFact,
} from "../src/db/model-relation-repository.js";

const AT = "2026-09-07T00:00:00.000Z";
const actor = { actor: "verified-access-subject" };
function input(overrides: Partial<ModelFactInput> = {}): ModelFactInput {
  return {
    kind: "successor",
    relatedProductId: 700002,
    familyName: "",
    position: null,
    state: "verified",
    sourceId: null,
    manualNote: "メーカー資料で前後継関係を確認しました。",
    manufacturerJustification: "",
    ...overrides,
  };
}
function fixture() {
  const result = migratedSqlite();
  result.sqlite.exec(`PRAGMA foreign_keys=ON;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<6)
    INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
    SELECT 700000+i,CASE WHEN i=6 THEN 'other' ELSE 'test-maker' END,'Model '||i,'MODEL'||i,'Model '||i,'${AT}','${AT}' FROM n;
    INSERT INTO knowledge_catalog_sources(id,product_id,source_type,source_url,content_hash,retrieved_at,created_at,updated_at)
    VALUES(880001,700001,'manufacturer_official','https://example.test/source','hash','${AT}','${AT}','${AT}');`);
  return result;
}

test("model fact input rejects unsupported relations, self-invented fields and unproven publication", () => {
  assert.ok(parseModelFactInput(input()));
  for (const value of [
    input({ manualNote: "" }),
    { ...input(), fuzzy: true },
    input({ relatedProductId: 0 }),
    input({ kind: "family" }),
    input({ position: 2 }),
  ])
    assert.equal(parseModelFactInput(value), null);
  assert.ok(parseModelFactInput(input({ state: "candidate", manualNote: "" })));
});

test("manual model decisions preserve timestamps on a no-op and audit each changed version", async () => {
  const { db, sqlite } = fixture();
  try {
    const first = (await saveModelFact(db, 700001, input(), actor, AT))!;
    const changes = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    const same = (await saveModelFact(
      db,
      700002,
      input(),
      { ...actor, id: first.id, expectedVersion: 1 },
      "2026-09-08T00:00:00Z",
    ))!;
    assert.equal(same.version, 1);
    assert.equal(same.verified_at, AT);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, changes);
    const next = (await saveModelFact(
      db,
      700001,
      input({ state: "candidate" }),
      { ...actor, id: first.id, expectedVersion: 1 },
      AT,
    ))!;
    assert.equal(next.version, 2);
    await assert.rejects(
      saveModelFact(db, 700001, input(), { ...actor, id: first.id, expectedVersion: 1 }, AT),
      /conflict/,
    );
    const audits = sqlite
      .prepare("SELECT * FROM knowledge_catalog_model_fact_audits ORDER BY id")
      .all();
    assert.equal(audits.length, 2);
    assert.equal(audits[1].actor, actor.actor);
    assert.equal(JSON.parse(String(audits[1].before_json)).data.state, "verified");
    assert.equal(JSON.parse(String(audits[1].after_json)).data.state, "candidate");
    sqlite.exec("DELETE FROM product_search_entities");
    assert.ok(await readModelFact(db, first.id));
    await assert.rejects(
      saveModelFact(db, 700001, input({ relatedProductId: 799999 }), actor, AT),
      /FOREIGN KEY/,
    );
  } finally {
    sqlite.close();
  }
});

test("verified successor chains reject cycles, self-links, forks and duplicates atomically", async () => {
  const { db, sqlite } = fixture();
  try {
    await saveModelFact(db, 700001, input(), actor, AT);
    await saveModelFact(db, 700002, input({ relatedProductId: 700003 }), actor, AT);
    for (const [from, to] of [
      [700003, 700001],
      [700003, 700003],
      [700001, 700004],
      [700001, 700002],
    ]) {
      await assert.rejects(saveModelFact(db, from, input({ relatedProductId: to }), actor, AT));
    }
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_model_facts").get()?.n,
      2,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_model_fact_audits").get()?.n,
      2,
    );
    await assert.rejects(
      saveModelFact(db, 700004, input({ relatedProductId: 700006 }), actor, AT),
      /catalog_model_fact_invalid/,
    );
    await saveModelFact(
      db,
      700004,
      input({
        relatedProductId: 700006,
        manufacturerJustification: "ブランド移管をメーカー資料で確認しました。",
      }),
      actor,
      AT,
    );
  } finally {
    sqlite.close();
  }
});

test("source loss, changes and ageing require review without a full catalog write", async () => {
  const { db, sqlite } = fixture();
  try {
    const fact = (await saveModelFact(
      db,
      700001,
      input({ sourceId: 880001, manualNote: "" }),
      actor,
      AT,
    ))!;
    assert.equal((await listModelFacts(db, 700001, AT))[0].review_state, "verified");
    sqlite.exec("UPDATE knowledge_catalog_sources SET status='missing' WHERE id=880001");
    assert.equal((await listModelFacts(db, 700001, AT))[0].review_state, "due");
    sqlite.exec(
      "UPDATE knowledge_catalog_sources SET status='active',content_hash='changed' WHERE id=880001",
    );
    assert.equal((await listModelFacts(db, 700001, AT))[0].review_state, "due");
    await saveModelFact(
      db,
      700001,
      input({ sourceId: 880001, manualNote: "" }),
      { ...actor, id: fact.id, expectedVersion: 1, reverify: true },
      AT,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_model_fact_audits").get()?.n,
      2,
    );
    assert.equal((await listModelFacts(db, 700001, AT))[0].review_state, "verified");
    assert.equal((await listModelFacts(db, 700001, "2027-09-07T00:00:00Z"))[0].review_state, "due");
    sqlite.exec("DELETE FROM knowledge_catalog_sources WHERE id=880001");
    const due = (await listModelFacts(db, 700001, AT))[0];
    assert.equal(due.review_state, "due");
    assert.equal(due.source_url, "https://example.test/source");
  } finally {
    sqlite.close();
  }
});

test("a failed family decision rolls back its new family and audit together", async () => {
  const { db, sqlite } = fixture();
  try {
    sqlite.exec(
      "CREATE TRIGGER reject_fact BEFORE INSERT ON knowledge_catalog_model_facts BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    await assert.rejects(
      saveModelFact(
        db,
        700001,
        input({ kind: "family", relatedProductId: null, familyName: "Rollback family" }),
        actor,
        AT,
      ),
      /injected/,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_model_families").get()?.n,
      0,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_catalog_model_fact_audits").get()?.n,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test("catalog deletion requires relationship review and keeps removed-decision audit", async () => {
  const { db, sqlite } = fixture();
  try {
    const fact = (await saveModelFact(db, 700001, input(), actor, AT))!;
    assert.throws(
      () => sqlite.exec("DELETE FROM knowledge_catalog_products WHERE id=700001"),
      /catalog_admin_model_facts_review_required/,
    );
    await saveModelFact(
      db,
      700001,
      input({ state: "removed" }),
      { ...actor, id: fact.id, expectedVersion: 1 },
      AT,
    );
    sqlite.exec("DELETE FROM knowledge_catalog_products WHERE id=700001");
    assert.equal(await readModelFact(db, fact.id), null);
    const audit = sqlite.prepare("SELECT * FROM knowledge_catalog_model_fact_audits").all();
    assert.equal(audit.length, 2);
  } finally {
    sqlite.close();
  }
});

test("families keep explicit order and symmetric variants canonicalize endpoint order", async () => {
  const { db, sqlite } = fixture();
  try {
    const family = input({
      kind: "family",
      relatedProductId: null,
      familyName: "Reference series",
      position: 1,
    });
    await saveModelFact(db, 700001, family, actor, AT);
    await assert.rejects(saveModelFact(db, 700002, family, actor, AT), /UNIQUE/);
    await saveModelFact(db, 700002, { ...family, position: 2 }, actor, AT);
    const variant = (await saveModelFact(
      db,
      700005,
      input({ kind: "variant", relatedProductId: 700003 }),
      actor,
      AT,
    ))!;
    assert.equal(variant.product_id, 700003);
    assert.equal(variant.related_product_id, 700005);
    await assert.rejects(
      saveModelFact(db, 700003, input({ kind: "variant", relatedProductId: 700005 }), actor, AT),
      /UNIQUE/,
    );
  } finally {
    sqlite.close();
  }
});
