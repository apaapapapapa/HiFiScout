import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { upsertProducts } from "../src/db/product-write-repository.js";
import { syncProductSearchEntities } from "../src/db/product-search-entity-repository.js";
import type { CatalogProductUpsertInput } from "../src/catalog/types.js";
import { invocationBudget, InvocationBudgetExceeded } from "../src/db/invocation-budget.js";
import { accountReads } from "../src/db/read-accounting.js";

test("entity sync yields before membership changes when the entire transition will not fit", async () => {
  const { sqlite, db } = migratedSqlite();
  sqlite.exec(`INSERT INTO products(shop_key, source_id, title, source_url, first_seen_at, last_seen_at, last_changed_at)
    VALUES ('hifido', 'one', 'C10', 'https://example.test/one', '2026', '2026', '2026')`);
  const small = invocationBudget(db, { maxCalls: 4 });
  await assert.rejects(
    syncProductSearchEntities(accountReads(small.db).db, "hifido", ["one"]),
    InvocationBudgetExceeded,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_search_entities").get()?.n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM product_search_entity_offers").get()?.n, 0);
  const enough = invocationBudget(db, { maxCalls: 10 });
  await syncProductSearchEntities(accountReads(enough.db).db, "hifido", ["one"]);
  assert.equal(
    sqlite.prepare("SELECT offer_count FROM product_search_entities").get()?.offer_count,
    1,
  );
  assert.ok(enough.metrics().d1Calls <= 10);
});

test("price-only crawler updates preserve search evidence and leave FTS storage untouched", async () => {
  const { sqlite, db } = migratedSqlite();
  const product: CatalogProductUpsertInput = {
    sourceId: "one",
    manufacturer: "LUXMAN",
    manufacturerId: "luxman",
    model: "C10",
    title: "LUXMAN C10",
    category: "アンプ",
    conditionText: "中古",
    priceYen: 100000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/one",
  };
  await upsertProducts(db, "hifido", [product], "2026-09-05T00:00:00Z");
  await syncProductSearchEntities(db, "hifido", [product.sourceId]);
  const fts = () =>
    sqlite.prepare("SELECT * FROM product_search_entities_fts_data ORDER BY id").all();
  const before = fts();
  sqlite.exec(`CREATE TABLE observed_projection_writes(n INTEGER);
    CREATE TRIGGER observe_projection AFTER UPDATE ON product_search_projection
    BEGIN INSERT INTO observed_projection_writes VALUES (1); END;`);
  await upsertProducts(db, "hifido", [{ ...product, priceYen: 90000 }], "2026-09-05T01:00:00Z");
  await syncProductSearchEntities(db, "hifido", [product.sourceId]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM observed_projection_writes").get()?.n, 0);
  assert.deepEqual(fts(), before);
  assert.equal(
    sqlite.prepare("SELECT lowest_price_yen FROM product_search_entities").get()?.lowest_price_yen,
    90000,
  );
  assert.equal(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'product_search_fts'").get(),
    undefined,
  );

  await upsertProducts(
    db,
    "hifido",
    [{ ...product, title: "LUXMAN SpecialEdition", priceYen: 90000 }],
    "2026-09-05T02:00:00Z",
  );
  await syncProductSearchEntities(db, "hifido", [product.sourceId]);
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) n FROM product_search_entities_fts WHERE product_search_entities_fts MATCH 'SpecialEdition'",
      )
      .get()?.n,
    1,
  );
  sqlite.exec(
    "INSERT INTO product_search_entities_fts(product_search_entities_fts, rank) VALUES ('integrity-check', 1)",
  );
});
