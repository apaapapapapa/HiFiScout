import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { MAX_SUGGESTIONS, suggestProducts } from "../src/db/product-suggest-repository.js";
import { captureDatabase } from "./helpers/d1.js";

function row(
  id: number,
  overrides: Partial<{
    manufacturer_id: string;
    manufacturer: string;
    model: string;
    normalized_model: string;
  }> = {},
) {
  return {
    id,
    manufacturer_id: "marantz",
    manufacturer: "",
    model: "PM-14S1",
    normalized_model: "pm14s1",
    ...overrides,
  };
}

test("model spelling variants use the trigram-indexed normalized model and return display form", async () => {
  const db = captureDatabase([row(1)]);

  const result = await suggestProducts(db, "pm 14s1");

  assert.deepEqual(result, ["Marantz PM-14S1", "Marantz"]);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /JOIN product_search_entities_fts/);
  assert.match(db.calls[0].sql, /product_search_entities_fts MATCH \?/);
  assert.match(String(db.calls[0].binds[0]), /normalized_model : "pm14s1"/);
  assert.equal(db.calls[0].binds.at(-1), 24);
  assert.doesNotMatch(db.calls[0].sql, /FROM products\b/);
});

test("one- and two-character suggestions use a bounded entity LIKE fallback", async () => {
  const db = captureDatabase([row(1)]);

  await suggestProducts(db, "PM");

  assert.equal(db.calls.length, 1);
  assert.doesNotMatch(db.calls[0].sql, /MATCH/);
  assert.match(db.calls[0].sql, /e\.manufacturer_terms LIKE \?/);
  assert.match(db.calls[0].sql, /e\.model_terms LIKE \?/);
  assert.match(db.calls[0].sql, /e\.normalized_model LIKE \?/);
  assert.deepEqual(db.calls[0].binds, ["%PM%", "%PM%", "%pm%", 24]);
});

test("suggestions are de-duplicated and capped independently of the candidate window", async () => {
  const rows = Array.from({ length: 24 }, (_, index) =>
    row(index + 1, {
      model: `PM-${index + 1}`,
      normalized_model: `pm${index + 1}`,
    }),
  );
  const db = captureDatabase(rows);

  const result = await suggestProducts(db, "PM");

  assert.equal(result.length, MAX_SUGGESTIONS);
  assert.equal(new Set(result.map((value) => value.toLocaleLowerCase())).size, result.length);
  assert.equal(db.calls[0].binds.at(-1), 24);
});

test("empty input does not query D1", async () => {
  const db = captureDatabase([row(1)]);
  assert.deepEqual(await suggestProducts(db, ""), []);
  assert.equal(db.calls.length, 0);
});
