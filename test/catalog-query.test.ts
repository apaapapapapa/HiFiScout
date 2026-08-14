import test from "node:test";
import assert from "node:assert/strict";

import { listProducts } from "../src/db/product-search-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import { productQuery } from "./helpers/product-query.js";

test("canonical category display names filter through indexed product categories", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?category=プリアンプ"));

  assert.match(db.calls[0].sql, /EXISTS \(SELECT 1 FROM product_categories pc/);
  assert.deepEqual(db.calls[0].binds.slice(0, 1), ["pre_amp"]);
});

test("manufacturer aliases filter through canonical manufacturer id", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?manufacturer=ラックスマン"));

  assert.match(db.calls[0].sql, /p\.manufacturer_id = \?/);
  assert.deepEqual(db.calls[0].binds.slice(0, 2), ["luxman", "ラックスマン"]);
});

test("multi-term free-text search ANDs terms inside one FTS match", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?q=tad%201000"));

  const { sql, binds } = db.calls[0];
  assert.match(sql, /product_search_fts MATCH \?/);
  assert.equal(binds[0], '"tad" AND "1000"');
  assert.doesNotMatch(sql, /p\.model LIKE \?/);
});

test("recent-only filter constrains products to retailer publication or discovery within the last 48 hours", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?newOnly=true"));

  assert.match(
    db.calls[0].sql,
    /COALESCE\(p\.source_published_at, p\.first_seen_at\) >= strftime\([^\n]+-48 hours/,
  );
});

test("price-dropped filter compares current and previous price", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?priceDropped=true"));

  assert.match(db.calls[0].sql, /p\.previous_price_yen IS NOT NULL/);
  assert.match(db.calls[0].sql, /p\.price_yen < p\.previous_price_yen/);
});

test("discovery filters combine with existing catalog filters in one SQL query", async () => {
  const db = captureDatabase();
  await listProducts(
    db,
    productQuery(
      "?shop=fujiya-avic&manufacturer=LUXMAN&minPrice=100000&inStock=true&newOnly=true&priceDropped=true",
    ),
  );

  const { sql, binds } = db.calls[0];
  assert.match(sql, /p\.shop_key = \?/);
  assert.match(sql, /p\.manufacturer_id = \?/);
  assert.match(sql, /p\.stock_status = 'in_stock'/);
  assert.match(
    sql,
    /COALESCE\(p\.source_published_at, p\.first_seen_at\) >= strftime\([^\n]+-48 hours/,
  );
  assert.match(sql, /p\.price_yen < p\.previous_price_yen/);
  assert.match(sql, /p\.price_yen >= \?/);
  assert.deepEqual(binds.slice(0, 4), ["fujiya-avic", "luxman", "LUXMAN", 100000]);
});
