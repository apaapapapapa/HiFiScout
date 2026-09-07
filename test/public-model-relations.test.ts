import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { saveModelFact } from "../src/db/model-relation-repository.js";
import { publicModelRelations } from "../src/db/public-model-relations-repository.js";
import { productSearchDetail } from "../src/db/product-search-repository.js";
import { isProductSearchItem } from "../frontend/api-client.js";
import { isProductModelRelations } from "../frontend/model-relations.js";
import { renderProductPermalinkHtml } from "../src/http/product-permalink.js";
import type { ModelFactInput } from "../src/catalog/types.js";

const AT = new Date().toISOString();
const actor = { actor: "private-reviewer-subject" };
const fact: ModelFactInput = {
  kind: "successor", relatedProductId: 700002, familyName: "", position: null,
  state: "verified", sourceId: null, manualNote: "private evidence: manufacturer verified succession", manufacturerJustification: "",
};
function fixture() {
  const value = migratedSqlite();
  value.sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5)
    INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
    SELECT 700000+i,'test-maker','Model '||i,'MODEL'||i,'Model '||i,'${AT}','${AT}' FROM n;
    INSERT INTO knowledge_catalog_sources(id,product_id,source_type,source_url,content_hash,retrieved_at,created_at,updated_at)
    VALUES(880001,700001,'manufacturer_official','https://example.test/official?x=1&y=2','hash','${AT}','${AT}','${AT}');`);
  return value;
}

test("public relations expose verified directions and ordered families without private evidence", async () => {
  const { db, sqlite } = fixture();
  try {
    await saveModelFact(db, 700001, { ...fact, sourceId: 880001, manualNote: "" }, actor, AT);
    await saveModelFact(db, 700001, { ...fact, kind: "variant", relatedProductId: 700003 }, actor, AT);
    await saveModelFact(db, 700001, { ...fact, relatedProductId: 700004, state: "candidate" }, actor, AT);
    const family = { ...fact, kind: "family" as const, relatedProductId: null, familyName: "Series <A>" };
    await saveModelFact(db, 700002, { ...family, position: 2 }, actor, AT);
    await saveModelFact(db, 700001, { ...family, position: 1 }, actor, AT);
    await saveModelFact(db, 700003, { ...family, position: 3, state: "candidate" }, actor, AT);
    const result = (await publicModelRelations(db, 700001, AT))!;
    assert.ok(isProductModelRelations(result));
    assert.deepEqual(result.links.map((link) => `${link.kind}:${link.key}`).sort(), ["successor:c-700002", "variant:c-700003"]);
    assert.deepEqual(result.families[0].members.map((member) => member.key), ["c-700001", "c-700002"]);
    assert.equal((await publicModelRelations(db, 700002, AT))?.links[0].kind, "predecessor");
    assert.equal((await publicModelRelations(db, 700003, AT))?.links[0].key, "c-700001");
    assert.doesNotMatch(JSON.stringify(result), /private|audit|source_id|content_hash|manualNote/);
    sqlite.exec("UPDATE knowledge_catalog_sources SET content_hash='changed' WHERE id=880001");
    assert.equal((await publicModelRelations(db, 700001, AT))?.links.length, 1);
    sqlite.exec("UPDATE knowledge_catalog_products SET verification_status='rejected' WHERE id=700003");
    assert.equal((await publicModelRelations(db, 700001, AT))?.links.length, 0);
    assert.equal(await publicModelRelations(db, 700001, new Date(Date.parse(AT) + 181 * 86400_000).toISOString()), undefined);
  } finally { sqlite.close(); }
});

test("verified products remain linkable without offers and SSR escapes relation content", async () => {
  const { db, sqlite } = fixture();
  try {
    sqlite.exec("UPDATE knowledge_catalog_products SET canonical_name='<script>Model B</script>' WHERE id=700002");
    await saveModelFact(db, 700001, { ...fact, sourceId: 880001, manualNote: "" }, actor, AT);
    const detail = (await productSearchDetail(db, "c-700001"))!;
    assert.equal(detail.product.offer_count, 0);
    assert.equal(detail.product.lowest_price_yen, null);
    assert.deepEqual(detail.offers, []);
    assert.ok(isProductSearchItem(detail.product));
    const html = renderProductPermalinkHtml(detail, "https://hifiscout.test");
    assert.match(html, /href="\/p\/c-700002"/);
    assert.match(html, /&lt;script&gt;Model B&lt;\/script&gt;/);
    assert.match(html, /official\?x=1&amp;y=2/);
    assert.match(html, /現在表示できる出品はありません/);
    assert.doesNotMatch(html, /private|<script>Model/);
    sqlite.exec("DELETE FROM product_search_entities");
    assert.ok((await productSearchDetail(db, "c-700001"))?.product.model_relations);
    sqlite.exec("UPDATE knowledge_catalog_products SET verification_status='rejected' WHERE id=700001");
    assert.equal(await productSearchDetail(db, "c-700001"), null);
    assert.equal(await productSearchDetail(db, "l-700001"), null);
  } finally { sqlite.close(); }
});

test("browser rejects malformed relation collections and unsafe provenance links", () => {
  const proof = { kind: "source", sourceUrl: "https://example.test", verifiedAt: AT };
  const link = { kind: "successor", key: "c-2", model: "B", manufacturer: "M", proof };
  assert.ok(isProductModelRelations({ links: [link], families: [] }));
  for (const invalid of [
    { links: [link], families: {} },
    { links: [{ ...link, key: "l-2" }], families: [] },
    { links: [{ ...link, proof: { ...proof, sourceUrl: "javascript:alert(1)" } }], families: [] },
    { links: [{ ...link, proof: { ...proof, verifiedAt: "invalid" } }], families: [] },
    { links: Array(41).fill(link), families: [] },
  ]) assert.equal(isProductModelRelations(invalid), false);
});
