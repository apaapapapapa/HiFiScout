import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  readOfferFactReplay,
  stepOfferFactReplay,
} from "../src/db/offer-fact-replay-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { handleAuthenticatedAdminEntryRequest } from "../src/admin/entry.js";

const AT = "2026-09-01T00:00:00Z";

test("replay requests cannot override the durable cursor or server batch size", async () => {
  let calls = 0;
  const env = {
    CATALOG_ADMIN: {
      stepOfferFactReplay: async () => {
        calls++;
        return {};
      },
    },
  } as unknown as Parameters<typeof handleAuthenticatedAdminEntryRequest>[1];
  const url = "https://admin.example.test/api/admin/offer-facts/replay";
  const send = (body: unknown, origin = "https://admin.example.test") =>
    handleAuthenticatedAdminEntryRequest(
      new Request(url, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  for (const body of [null, [], { afterId: 100 }, { limit: 10000 }]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal((await send({}, "https://other.example.test")).status, 403);
  assert.equal(calls, 0);
  assert.equal((await send({})).status, 200);
  assert.equal(calls, 1);
});

function fixture() {
  const fixture = migratedSqlite();
  fixture.sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<30)
    INSERT INTO products(id,shop_key,source_id,title,condition_text,source_url,is_active,first_seen_at,last_seen_at,last_changed_at)
    SELECT i,'shop',CAST(i AS TEXT),'Amp A1',CASE WHEN i=1 THEN '元箱あり。当店保証付き。目立つ傷なし。整備済み。動作確認済み' ELSE '元箱なし' END,
      'https://example.test/'||i,CASE WHEN i=2 THEN 0 ELSE 1 END,'${AT}','${AT}','${AT}' FROM n`);
  return fixture;
}

test("replay resumes a fixed horizon, records active coverage and retains original observation dates", async () => {
  const { db, sqlite } = fixture();
  try {
    assert.equal(await readOfferFactReplay(db), null);
    const original = sqlite.prepare("SELECT * FROM products").all();
    sqlite.exec(
      `INSERT INTO product_offer_facts (product_id,fact_id,source,state,source_field,rule_id,confidence,observed_at) VALUES (1,'original_box','manual','unknown','manual','fixture',1,'${AT}')`,
    );
    const first = await stepOfferFactReplay(db);
    assert.equal(first?.scannedCount, 25);
    assert.equal(first?.activeCount, 24);
    assert.equal(first?.completedAt, null);
    sqlite.exec(`INSERT INTO products(id,shop_key,source_id,title,condition_text,source_url,first_seen_at,last_seen_at,last_changed_at)
      VALUES (100,'shop','new','New amp','元箱あり','https://example.test/new','${AT}','${AT}','${AT}')`);
    const final = await stepOfferFactReplay(db);
    assert.equal(final?.scannedCount, 30);
    assert.equal(final?.maxProductId, 30);
    assert.equal(final?.activeCount, 29);
    assert.ok(final?.completedAt);
    assert.equal(
      sqlite
        .prepare(
          "SELECT state FROM product_offer_facts WHERE product_id=2 AND fact_id='original_box' AND source='seller'",
        )
        .get()?.state,
      "absent",
      "inactive listings are also reprocessed",
    );
    assert.equal(final?.coverage.byShop.length, 1);
    const coverage = final!.coverage.byShop[0];
    assert.equal(coverage.key, "shop");
    assert.equal(coverage.listings, 29);
    assert.equal(coverage.condition, 0);
    assert.equal(coverage.included, 29);
    assert.equal(coverage.warranty, 1);
    assert.equal(coverage.sale_unit, 0);
    assert.equal(coverage.appearance, 1);
    assert.equal(coverage.operation, 1);
    assert.equal(coverage.maintenance, 1);
    assert.equal(final?.coverage.byCategory[0].appearance, 1);
    assert.equal(final?.coverage.byCategory[0].maintenance, 1);
    assert.equal(final?.coverage.byCategory[0].included, 29);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM product_offer_facts WHERE product_id=100").get()?.n,
      0,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT observed_at FROM product_offer_facts WHERE product_id=1 AND source='seller' LIMIT 1",
        )
        .get()?.observed_at,
      AT,
    );
    assert.equal(
      sqlite.prepare("SELECT state FROM product_offer_facts WHERE source='manual'").get()?.state,
      "unknown",
    );
    assert.deepEqual(sqlite.prepare("SELECT * FROM products WHERE id<=30").all(), original);
    const before = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    await stepOfferFactReplay(db);
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, before);
  } finally {
    sqlite.close();
  }
});

test("a failed replay batch leaves both facts and its durable cursor unchanged", async () => {
  const { db, sqlite } = fixture();
  try {
    sqlite.exec(
      "CREATE TRIGGER fail_replay BEFORE INSERT ON product_offer_facts WHEN NEW.product_id=2 BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    await assert.rejects(stepOfferFactReplay(db), /injected/u);
    assert.equal((await readOfferFactReplay(db))?.afterId, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM product_offer_facts").get()?.n, 0);
    sqlite.exec("DROP TRIGGER fail_replay");
    assert.equal((await stepOfferFactReplay(db))?.scannedCount, 25);
  } finally {
    sqlite.close();
  }
});

test("changed source evidence fences the entire stale batch before it can advance", async () => {
  const { db, sqlite } = fixture();
  let changed = false;
  const concurrent: QueryableDatabase = {
    ...db,
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      if (!changed) {
        changed = true;
        sqlite.exec("UPDATE products SET condition_text='元箱なし' WHERE id=1");
      }
      return db.batch<T>(statements);
    },
  };
  try {
    assert.equal((await stepOfferFactReplay(concurrent))?.afterId, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM product_offer_facts").get()?.n, 0);
    assert.equal((await stepOfferFactReplay(db))?.scannedCount, 25);
    assert.equal(
      sqlite
        .prepare(
          "SELECT state FROM product_offer_facts WHERE product_id=1 AND fact_id='original_box'",
        )
        .get()?.state,
      "absent",
    );
  } finally {
    sqlite.close();
  }
});

test("concurrent replay callers cannot double-count coverage or overwrite the winning token", async () => {
  const { db, sqlite } = fixture();
  let intercepted = false;
  const concurrent: QueryableDatabase = {
    ...db,
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      if (!intercepted) {
        intercepted = true;
        await stepOfferFactReplay(db);
      }
      return db.batch<T>(statements);
    },
  };
  try {
    const result = await stepOfferFactReplay(concurrent);
    assert.equal(result?.scannedCount, 25);
    assert.equal(result?.coverage.byShop[0].listings, 24);
    assert.equal((await stepOfferFactReplay(db))?.scannedCount, 30);
  } finally {
    sqlite.close();
  }
});
