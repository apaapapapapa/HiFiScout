import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { migrationSources } from "./helpers/migrations.js";
import { saveSellerDetailOfferFacts } from "../src/db/seller-detail-offer-repository.js";
import { effectiveOfferFacts, sellerOfferFactWrites } from "../src/db/offer-fact-repository.js";
import { updateOfferFactAdmin } from "../src/db/offer-fact-admin-repository.js";
import { recordInventoryUnavailable } from "../src/db/inventory-recheck-repository.js";
import type { OfferFact } from "../src/catalog/types.js";

const AT = "2026-09-11T00:00:00.000Z";
const NEXT = "2026-09-12T00:00:00.000Z";
const seed = `INSERT INTO products(id,shop_key,source_id,title,source_url,stock_status,first_seen_at,last_seen_at,last_changed_at)
  VALUES(1,'audiounion','226142','LUXMAN D-07X','https://www.audiounion.jp/ct/detail/used/226142/','in_stock','${AT}','${AT}','${AT}')`;
const remote = (state: "present" | "absent", observedAt = AT): OfferFact => ({
  factId: "remote_control",
  state,
  source: "seller_detail",
  sourceField: "detail_accessories",
  ruleId: "audiounion.detail.v1.remote_control",
  confidence: 1,
  observedAt,
});

test("detail evidence, changed list evidence and manual unknown keep consistent authority", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(seed);
    const list = (condition: string) =>
      db.batch(sellerOfferFactWrites(db, "audiounion", "226142", "LUXMAN D-07X", condition, NEXT));
    const effective = async () => (await effectiveOfferFacts(db, [1])).get(1)?.[0];
    await list("リモコンあり");
    await saveSellerDetailOfferFacts(db, 1, [remote("absent")]);
    assert.equal((await effective())?.state, "absent");
    await list("リモコンあり");
    assert.equal((await effective())?.source, "seller_detail");
    await saveSellerDetailOfferFacts(db, 1, [remote("absent", NEXT)]);
    assert.equal((await effective())?.observedAt, AT);
    await updateOfferFactAdmin(db, 1, { remote_control: "unknown" }, AT);
    assert.equal((await effective())?.state, "unknown");
    await updateOfferFactAdmin(db, 1, { remote_control: "inherit" }, NEXT);
    await saveSellerDetailOfferFacts(db, 1, [remote("present", NEXT)]);
    await list("リモコンなし");
    assert.equal((await effective())?.source, "seller");
    assert.equal((await effective())?.state, "absent");
    await saveSellerDetailOfferFacts(db, 1, [remote("present", NEXT)]);
    await updateOfferFactAdmin(db, 1, { remote_control: "unknown" }, AT);
    await saveSellerDetailOfferFacts(db, 1, []);
    assert.equal((await effective())?.state, "unknown");
  } finally {
    sqlite.close();
  }
});

test("offer fact migration preserves old evidence and enforces warranty bounds", () => {
  const name = "0120_seller_detail_offer_facts.sql";
  const { sqlite } = migratedSqlite({ before: name });
  try {
    sqlite.exec(seed);
    sqlite.exec(`INSERT INTO product_offer_facts VALUES
      (1,'remote_control','seller','present','condition_text','offer.v3.remote_control',1,'${AT}'),
      (1,'remote_control','manual','unknown','manual','admin.offer.v1',1,'${AT}')`);
    const before = sqlite.prepare("SELECT * FROM product_offer_facts ORDER BY source").all();
    sqlite.exec(migrationSources.find((m) => m.name === name)!.sql);
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at FROM product_offer_facts ORDER BY source",
        )
        .all(),
      before,
    );
    const insert = sqlite.prepare(
      `INSERT INTO product_offer_facts VALUES(1,'shop_warranty','seller_detail','present','detail_warranty','fixture',1,?,?)`,
    );
    for (const months of [0, 121, -1, 1.5]) assert.throws(() => insert.run(AT, months), /CHECK/);
    insert.run(AT, 6);
    assert.equal(
      sqlite
        .prepare("SELECT warranty_months FROM product_offer_facts WHERE fact_id='shop_warranty'")
        .get()?.warranty_months,
      6,
    );
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
  }
});

test("explicit sold status is immediate while disappearance and deactivation remain guarded", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(seed);
    const row = () =>
      sqlite
        .prepare("SELECT stock_status,is_active,last_changed_at FROM products WHERE id=1")
        .get();
    await recordInventoryUnavailable(db, 1, NEXT, 1, false, "missing");
    assert.deepEqual({ ...row() }, { stock_status: "in_stock", is_active: 1, last_changed_at: AT });
    await recordInventoryUnavailable(db, 1, NEXT, 1, false, "sold");
    assert.deepEqual(
      { ...row() },
      { stock_status: "sold_out", is_active: 1, last_changed_at: NEXT },
    );
    await recordInventoryUnavailable(db, 1, "2026-09-13", 1, false, "sold");
    assert.equal(row()?.last_changed_at, NEXT);
    await recordInventoryUnavailable(db, 1, "2026-09-14", 2, true, "sold");
    assert.equal(row()?.is_active, 0);
  } finally {
    sqlite.close();
  }
});
