import { test } from "vite-plus/test";
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
  assert.match(db.calls[0].sql, /ec\.category_id IN \(/);
  assert.deepEqual(db.calls[0].binds.slice(0, descendants.length), descendants);
});

test("leaf DAC category remains a product-type filter", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?category=dac"));
  const acceptedIds = categoryFilterIds("dac");
  assert.ok(acceptedIds.includes("PRC.DAC"));
  assert.ok(acceptedIds.includes("dac"));
  assert.match(db.calls[0].sql, /ec\.category_id IN \(/);
  assert.doesNotMatch(db.calls[0].sql, /product_feature_facts/);
  assert.deepEqual(db.calls[0].binds.slice(0, acceptedIds.length), acceptedIds);
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

test("facet values are ORed within one dimension and dimensions are ANDed", async () => {
  const db = captureDatabase();
  await searchProducts(
    db,
    productQuery("?facet=connector_a:xlr&facet=connector_a:rca&facet=signal_type:analog"),
  );

  const call = db.calls[0];
  assert.equal((call.sql.match(/JOIN product_facet_facts pff/g) || []).length, 2);
  assert.equal((call.sql.match(/EXISTS \(/g) || []).length, 2);
  assert.match(call.sql, /pff\.facet_value IN \(\?,\?\)/);
  assert.match(call.sql, /pff\.facet_value IN \(\?\)/);
  assert.deepEqual(call.binds.slice(0, 5), ["connector_a", "xlr", "rca", "signal_type", "analog"]);
});

test("transport filter includes canonical and legacy stored ids during replay", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?category=transport"));

  const acceptedIds = categoryFilterIds("transport");
  for (const id of ["SRC.DISC", "SRC.STREAMER", "PRC.DDC", "transport"]) {
    assert.ok(acceptedIds.includes(id), id);
  }
  assert.deepEqual(db.calls[0].binds.slice(0, acceptedIds.length), acceptedIds);
});

test("legacy network transport filter resolves only to the streamer product type", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?category=network_transport"));
  const acceptedIds = categoryFilterIds("network_transport");
  assert.ok(acceptedIds.includes("SRC.STREAMER"));
  assert.ok(acceptedIds.includes("network_transport"));
  assert.equal(acceptedIds.includes("SRC.DISC"), false);
  assert.deepEqual(db.calls[0].binds.slice(0, acceptedIds.length), acceptedIds);
});

test("legacy CD/SACD transport filter resolves only to the disc product type", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?category=cd_sacd_transport"));
  const acceptedIds = categoryFilterIds("cd_sacd_transport");
  assert.ok(acceptedIds.includes("SRC.DISC"));
  assert.ok(acceptedIds.includes("cd_sacd_transport"));
  assert.equal(acceptedIds.includes("SRC.STREAMER"), false);
  assert.deepEqual(db.calls[0].binds.slice(0, acceptedIds.length), acceptedIds);
});
