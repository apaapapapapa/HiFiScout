import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { inferOfferFacts, OFFER_FACT_RULE_VERSION } from "../src/catalog/offer-facts.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { sellerOfferFactWrites } from "../src/db/offer-fact-repository.js";
import { createCompleteExportPlan, readCompleteExportPage } from "../src/export/complete-csv.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const AT = "2026-09-07T00:00:00.000Z";
const LATER = "2026-09-08T00:00:00.000Z";
const states = (title: string, condition = "") =>
  Object.fromEntries(
    inferOfferFacts(title, condition, AT).map((fact) => [fact.factId, fact.state]),
  );

test("offer facts preserve explicit positive, negative and unknown evidence", () => {
  assert.deepEqual(
    states("展示品", "元箱なし。リモコン付属。説明書あり。当店保証付き。動作確認済み"),
    {
      display: "present",
      operation_confirmed: "present",
      original_box: "absent",
      remote_control: "present",
      manual: "present",
      shop_warranty: "present",
    },
  );
  for (const text of ["新品同様", "リモコン対応", "付属品不明", "元箱別売", "Aランク", ""]) {
    assert.deepEqual(states(text), {}, text);
  }
  assert.deepEqual(states("元箱付属なし。リモコンは付属しません"), {
    original_box: "absent",
    remote_control: "absent",
  });
  assert.deepEqual(states("元箱あり", "元箱なし"), {});
  assert.deepEqual(states("動作確認済み", "動作未確認"), {});
  assert.deepEqual(states("展示品ではありません。未使用品ではありません"), {});
});

test("sale units are explicit and never inferred from a model or pair-compatible feature", () => {
  assert.deepEqual(states("スピーカー（ペア）"), { sale_pair: "present" });
  assert.deepEqual(states("スピーカー（１本）"), { sale_single: "present" });
  assert.deepEqual(states("モノラルアンプ 2台セット"), { sale_set: "present" });
  assert.deepEqual(states("Bluetooth ペアリング"), {});
  assert.deepEqual(states("モノラルアンプ"), {});
  assert.deepEqual(states("ペア販売", "1本のみ"), {});
});

test("facts carry field provenance and a bounded rule identifier without seller prose", () => {
  const [fact] = inferOfferFacts("製品名", "元箱あり", AT);
  assert.deepEqual(fact, {
    factId: "original_box",
    state: "present",
    source: "seller",
    sourceField: "condition_text",
    ruleId: `offer.v${OFFER_FACT_RULE_VERSION}.original_box`,
    confidence: 1,
    observedAt: AT,
  });
});

test("appearance, functional faults and service history remain independent seller claims", () => {
  assert.deepEqual(
    states("中古品", "目立った傷なし。動作不良あり。整備済み。修理歴あり。改造歴なし"),
    {
      used: "present",
      appearance_clean: "present",
      operation_fault: "present",
      maintenance_serviced: "present",
      maintenance_repaired: "present",
      maintenance_modified: "absent",
    },
  );
  assert.deepEqual(states("傷・汚れあり。オーバーホール済。改造済み"), {
    appearance_wear: "present",
    maintenance_serviced: "present",
    maintenance_modified: "present",
  });
  for (const text of [
    "Aランク",
    "修理可能",
    "整備予定",
    "修理歴不明",
    "動作不良なし",
    "整備済みではありません",
    "傷なしを希望",
  ]) {
    assert.deepEqual(states(text), {}, text);
  }
  assert.deepEqual(states("修理歴あり", "修理歴なし"), {});
});

function listing(conditionText: string) {
  return normalizeCatalogProduct({
    sourceId: "one",
    manufacturer: "YAMAHA",
    model: "CD-S3000",
    title: "YAMAHA CD-S3000",
    conditionText,
    priceYen: 300000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/one",
  });
}

test("facts persist atomically with the listing and preserve manual decisions on refresh", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    await upsertProducts(db, "facts", [listing("元箱あり。リモコン付属")], AT);
    const rows = () =>
      sqlite
        .prepare(
          "SELECT fact_id, state, source, observed_at FROM product_offer_facts ORDER BY fact_id, source",
        )
        .all();
    assert.equal(rows().length, 2);
    const before = rows();
    await db.batch(
      sellerOfferFactWrites(db, "facts", "one", "YAMAHA CD-S3000", "元箱あり。リモコン付属", LATER),
    );
    assert.deepEqual(rows(), before, "equal facts retain their original observation time");
    sqlite.exec(
      `INSERT INTO product_offer_facts SELECT id, 'original_box', 'manual', 'absent', 'manual', 'admin', 1, '${AT}' FROM products`,
    );
    const plan = await createCompleteExportPlan(db, "all", 1);
    const table = plan.tables.findIndex((entry) => entry.name === "product_offer_facts");
    const exported = await readCompleteExportPage(db, plan, { table, after: null });
    assert.equal(exported.rows, 3, "full exports retain both seller and manual evidence");
    assert.match(new TextDecoder().decode(exported.bytes), /"manual","absent","manual"/u);
    await upsertProducts(db, "facts", [listing("元箱なし")], LATER);
    assert.deepEqual(
      rows().map((row) => [row.fact_id, row.state, row.source]),
      [
        ["original_box", "absent", "manual"],
        ["original_box", "absent", "seller"],
      ],
    );
    await upsertProducts(db, "facts", [listing("")], LATER);
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].source, "manual");
    sqlite.exec("DELETE FROM products");
    assert.equal(rows().length, 0);
  } finally {
    sqlite.close();
  }
});

test("a failed listing transaction cannot leave offer facts behind", async () => {
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(
      "CREATE TRIGGER fail_history BEFORE INSERT ON price_history BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    await assert.rejects(upsertProducts(db, "facts", [listing("元箱あり")], AT), /injected/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_offer_facts").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM products").get()?.n, 0);
  } finally {
    sqlite.close();
  }
});
