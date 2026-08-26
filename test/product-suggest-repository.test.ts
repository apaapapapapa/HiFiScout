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

test("mixed FTS and short terms keep the short term as a post-FTS predicate", async () => {
  const db = captureDatabase([row(1)]);

  await suggestProducts(db, "Marantz 14");

  assert.equal(db.calls.length, 1);
  const { sql, binds } = db.calls[0];
  assert.match(sql, /product_search_entities_fts MATCH \?/);
  assert.match(sql, /e\.manufacturer_terms LIKE \? ESCAPE/);
  assert.match(sql, /e\.normalized_model LIKE \? ESCAPE/);
  assert.match(sql, /e\.model_terms LIKE \? ESCAPE/);
  assert.match(sql, /e\.title_terms LIKE \? ESCAPE/);
  assert.match(sql, /e\.category_terms LIKE \? ESCAPE/);
  assert.equal(binds.filter((value) => value === "%14%").length, 5);
  assert.equal(binds.at(-1), 24);
});

test("one- and two-character whole queries never scan D1", async () => {
  for (const query of ["P", "PM"]) {
    const db = captureDatabase([row(1)]);
    assert.deepEqual(await suggestProducts(db, query), []);
    assert.equal(db.calls.length, 0);
  }
});

test("suggestions are de-duplicated and capped independently of the candidate window", async () => {
  const rows = Array.from({ length: 24 }, (_, index) =>
    row(index + 1, {
      model: `PM-${index + 1}`,
      normalized_model: `pm${index + 1}`,
    }),
  );
  const db = captureDatabase(rows);

  const result = await suggestProducts(db, "PM1");

  assert.equal(result.length, MAX_SUGGESTIONS);
  assert.equal(new Set(result.map((value) => value.toLocaleLowerCase())).size, result.length);
  assert.equal(db.calls[0].binds.at(-1), 24);
});

test("empty input does not query D1", async () => {
  const db = captureDatabase([row(1)]);
  assert.deepEqual(await suggestProducts(db, ""), []);
  assert.equal(db.calls.length, 0);
});
