import test from "node:test";
import assert from "node:assert/strict";

import { validateProductQuery } from "../src/api/product-query.js";
import { categoryFilterIds } from "../src/catalog/categories.js";
import { searchProducts } from "../src/db/product-search-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import { productQuery } from "./helpers/product-query.js";

test("a group category expands to every descendant a product could be classified as", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?category=amplifier"));

  const descendants = categoryFilterIds("amplifier");
  assert.ok(descendants.includes("amplifier"));
  assert.ok(descendants.includes("integrated_amp"));
  assert.ok(descendants.includes("headphone_amp"));
  assert.ok(!descendants.includes("dac"));
  assert.match(db.calls[0].sql, /e\.primary_category_id IN \(/);
  assert.deepEqual(db.calls[0].binds.slice(0, descendants.length), descendants);
});

test("leaf DAC category remains a product-type filter", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?category=dac"));
  assert.match(db.calls[0].sql, /e\.primary_category_id IN \(\?\)/);
  assert.doesNotMatch(db.calls[0].sql, /product_feature_facts/);
  assert.equal(db.calls[0].binds[0], "dac");
});

test("feature=dac is a product-level filter over the product's own listings", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?feature=dac"));
  assert.match(db.calls[0].sql, /product_feature_facts pff/);
  assert.match(db.calls[0].sql, /pff\.state = 'present'/);
  assert.match(db.calls[0].sql, /m\.entity_id = e\.id/);
  assert.equal(db.calls[0].binds[0], "dac");
});

test("multiple feature parameters are ANDed and unknown feature ids are rejected", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?feature=dac&feature=network_playback"));
  assert.equal((db.calls[0].sql.match(/product_feature_facts pff/g) || []).length, 2);
  assert.deepEqual(db.calls[0].binds.slice(0, 2), ["dac", "network_playback"]);
  assert.equal(
    validateProductQuery(new URL("https://example.test/api/product-search?feature=magic")),
    "feature_invalid",
  );
});

test("legacy network transport filter resolves to transport", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?category=network_transport"));
  assert.equal(db.calls[0].binds[0], "transport");
});

test("legacy CD/SACD transport filter resolves to transport", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?category=cd_sacd_transport"));
  assert.equal(db.calls[0].binds[0], "transport");
});
