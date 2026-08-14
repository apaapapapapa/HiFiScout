import test from "node:test";
import assert from "node:assert/strict";

import { searchProducts } from "../src/db/product-search-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import { productQuery } from "./helpers/product-query.js";

test("canonical category display names filter on the entity's canonical category", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?category=プリアンプ"));

  assert.match(db.calls[0].sql, /e\.primary_category_id IN \(\?\)/);
  assert.deepEqual(db.calls[0].binds.slice(0, 1), ["pre_amp"]);
});

test("manufacturer aliases filter through canonical manufacturer id", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?manufacturer=ラックスマン"));

  assert.match(db.calls[0].sql, /e\.manufacturer_id = \?/);
  assert.deepEqual(db.calls[0].binds.slice(0, 2), ["luxman", "ラックスマン"]);
});

test("multi-term free-text search ANDs terms inside one entity FTS match", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?q=tad%201000"));

  const { sql, binds } = db.calls[0];
  assert.match(sql, /product_search_entities_fts MATCH \?/);
  assert.equal(binds[0], '"tad" AND "1000"');
  assert.doesNotMatch(sql, /product_search_fts MATCH/);
});

test("recent-only filter constrains offers to publication or discovery within the last 48 hours", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?newOnly=true"));

  assert.match(
    db.calls[0].sql,
    /COALESCE\(p\.source_published_at, p\.first_seen_at\) >= strftime\([^\n]+-48 hours/,
  );
});

test("price-dropped filter compares current and previous price of one offer", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?priceDropped=true"));

  assert.match(db.calls[0].sql, /p\.previous_price_yen IS NOT NULL/);
  assert.match(db.calls[0].sql, /p\.price_yen < p\.previous_price_yen/);
});

test("offer filters are conjoined inside one EXISTS so they must hold for the same offer", async () => {
  const db = captureDatabase();
  await searchProducts(
    db,
    productQuery(
      "?shop=fujiya-avic&manufacturer=LUXMAN&minPrice=100000&inStock=true&newOnly=true&priceDropped=true",
    ),
  );

  const { sql, binds } = db.calls[0];
  const existsClauses = sql.match(/EXISTS \(\s*SELECT 1 FROM product_search_entity_offers/g) || [];
  assert.equal(existsClauses.length, 1);
  assert.match(sql, /p\.shop_key = \?/);
  assert.match(sql, /e\.manufacturer_id = \?/);
  assert.match(sql, /p\.stock_status = 'in_stock'/);
  assert.match(
    sql,
    /COALESCE\(p\.source_published_at, p\.first_seen_at\) >= strftime\([^\n]+-48 hours/,
  );
  assert.match(sql, /p\.price_yen < p\.previous_price_yen/);
  assert.match(sql, /p\.price_yen >= \?/);
  // The request-scoped sort subquery is bound before the main WHERE clause.
  assert.deepEqual(binds.slice(0, 4), ["fujiya-avic", 100000, "luxman", "LUXMAN"]);
});

test("a product with no offer filters needs no offer subquery at all", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?manufacturer=LUXMAN"));

  assert.doesNotMatch(db.calls[0].sql, /EXISTS \(\s*SELECT 1 FROM product_search_entity_offers/);
});
