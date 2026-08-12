import test from "node:test";
import assert from "node:assert/strict";
import { listProducts } from "../src/db/product-search-repository.js";

function queryCaptureDb(results = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...binds) {
          calls.push({ sql, binds });
          return {
            async all() {
              return { results };
            },
          };
        },
      };
    },
  };
}

test("TAD 1000 uses the search projection FTS5 index conjunctively", async () => {
  const db = queryCaptureDb([]);
  await listProducts(db, new URL("https://example.test/api/products?q=TAD%201000&limit=50"));

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /JOIN product_search_projection/);
  assert.match(db.calls[0].sql, /JOIN product_search_fts/);
  assert.match(db.calls[0].sql, /product_search_fts MATCH \?/);
  assert.equal(db.calls[0].binds[0], '"TAD" AND "1000"');
  assert.doesNotMatch(db.calls[0].sql, /p\.title LIKE/);
});

test("short search tokens are ANDed through projection LIKE without bypassing FTS terms", async () => {
  const db = queryCaptureDb([]);
  await listProducts(db, new URL("https://example.test/api/products?q=SE%20TAD&sort=newest"));

  assert.match(db.calls[0].sql, /product_search_fts MATCH \?/);
  assert.equal(db.calls[0].binds[0], '"TAD"');
  assert.ok(db.calls[0].binds.includes("%SE%"));
});

test("explicit sort keeps stable keyset ordering instead of relevance offset mode", async () => {
  const db = queryCaptureDb([]);
  await listProducts(db, new URL("https://example.test/api/products?q=TAD%201000&sort=newest"));

  assert.match(db.calls[0].sql, /ORDER BY p\.last_activity_at DESC, p\.id DESC/);
  assert.doesNotMatch(db.calls[0].sql, /bm25/);
});
