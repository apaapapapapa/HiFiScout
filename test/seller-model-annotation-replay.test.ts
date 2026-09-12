import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { MODEL_RESOLVER_VERSION } from "../src/catalog/model-resolver.js";
import { replayAdminCsvListings } from "../src/db/data-quality-remediation-service.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { productQuery } from "./helpers/product-query.js";

test("targeted replay corrects historical seller names and search without replacing raw evidence", async () => {
  const { sqlite, db } = migratedSqlite();
  const at = "2026-09-12T02:00:00.000Z";
  const cases = [
    {
      id: 8855,
      shop: "rewire",
      raw: "K-05 Super Audio",
      model: "K-05",
      title: "ESOTERIC K-05 Super Audio CD Player エソテリック SACDプレーヤー",
    },
    {
      id: 8864,
      shop: "rewire",
      raw: "K-05Xs Super Audio CD/CD Player",
      model: "K-05Xs",
      title: "ESOTERIC K-05Xs Super Audio CD/CD Player エソテリック SACDプレーヤー",
    },
    {
      id: 8717,
      shop: "tereon",
      raw: "Grandioso P1+Grandioso D1(元箱あり)(セット販売)(整備済み)",
      model: "Grandioso P1 + Grandioso D1",
      title: "ESOTERIC Grandioso P1+Grandioso D1(元箱あり)(セット販売)(整備済み)",
    },
  ];
  try {
    for (const item of cases) {
      sqlite
        .prepare(`INSERT INTO products
        (id,shop_key,source_id,source_url,title,manufacturer,raw_manufacturer,manufacturer_id,
         canonical_manufacturer_id,raw_model,model,normalized_model,model_resolution_status,
         model_resolver_version,first_seen_at,last_seen_at,last_changed_at,price_yen,stock_status)
        VALUES (?,?,?,'https://example.test/item',?,'ESOTERIC','ESOTERIC','esoteric','esoteric',
                ?,?,'LEGACY','resolved',12,?,?,?,100000,'in_stock')`)
        .run(item.id, item.shop, String(item.id), item.title, item.raw, item.raw, at, at, at);
    }
    await replayAdminCsvListings(
      db,
      cases.map((item) => item.id),
      at,
    );
    for (const item of cases) {
      const row = sqlite.prepare("SELECT * FROM products WHERE id = ?").get(item.id);
      assert.equal(row?.model, item.model);
      assert.equal(row?.raw_model, item.raw);
      assert.equal(row?.title, item.title);
      assert.equal(row?.price_yen, 100000);
      assert.equal(row?.stock_status, "in_stock");
      assert.equal(row?.model_resolver_version, MODEL_RESOLVER_VERSION);
      assert.equal(row?.remediation_projection_required, 0);
    }
    const search = await searchProducts(db, productQuery("?q=ESOTERIC"));
    assert.deepEqual(
      search.items.map((item) => item.model).sort(),
      cases.map((item) => item.model).sort(),
    );
    const before = sqlite
      .prepare("SELECT id,model,raw_model,title,last_changed_at FROM products ORDER BY id")
      .all();
    await replayAdminCsvListings(
      db,
      cases.map((item) => item.id),
      "2026-09-12T03:00:00.000Z",
    );
    assert.deepEqual(
      sqlite
        .prepare("SELECT id,model,raw_model,title,last_changed_at FROM products ORDER BY id")
        .all(),
      before,
    );
  } finally {
    sqlite.close();
  }
});
