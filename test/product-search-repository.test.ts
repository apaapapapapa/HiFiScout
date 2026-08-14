import test from "node:test";
import assert from "node:assert/strict";
import { listProducts } from "../src/db/product-search-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import { productQuery } from "./helpers/product-query.js";

test("TAD 1000 uses the search projection FTS5 index conjunctively", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?q=TAD%201000&limit=50"));

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /JOIN product_search_projection/);
  assert.match(db.calls[0].sql, /JOIN product_search_fts/);
  assert.match(db.calls[0].sql, /product_search_fts MATCH \?/);
  assert.equal(db.calls[0].binds[0], '"TAD" AND "1000"');
  assert.doesNotMatch(db.calls[0].sql, /p\.title LIKE/);
});

test("short search tokens are ANDed through projection LIKE without bypassing FTS terms", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?q=SE%20TAD&sort=newest"));

  assert.match(db.calls[0].sql, /product_search_fts MATCH \?/);
  assert.equal(db.calls[0].binds[0], '"TAD"');
  assert.ok(db.calls[0].binds.includes("%SE%"));
});

test("a search too short for the tokenizer stays on the projection instead of listing columns", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?q=MC"));

  const { sql, binds } = db.calls[0];
  assert.match(sql, /JOIN product_search_projection/);
  assert.doesNotMatch(sql, /product_search_fts MATCH/);
  assert.match(sql, /sp\.manufacturer_terms LIKE \?/);
  assert.match(sql, /sp\.category_terms LIKE \?/);
  assert.doesNotMatch(sql, /p\.raw_manufacturer LIKE/);
  assert.equal(binds.filter((value) => value === "%MC%").length, 5);
});

test("single long free-text terms match through the projection FTS index", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?q=LUXMAN"));

  assert.match(db.calls[0].sql, /JOIN product_search_fts/);
  assert.deepEqual(db.calls[0].binds.slice(0, 1), ['"LUXMAN"']);
});

test("explicit sort keeps stable keyset ordering instead of relevance offset mode", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?q=TAD%201000&sort=newest"));

  assert.match(db.calls[0].sql, /ORDER BY p\.last_activity_at DESC, p\.id DESC/);
  assert.doesNotMatch(db.calls[0].sql, /bm25/);
});

test("relevance mode ranks exact identity matches ahead of bm25 and drops the cursor", async () => {
  const rows = [
    { id: 5, last_activity_at: "2026-08-11T03:00:00Z" },
    { id: 4, last_activity_at: "2026-08-11T02:00:00Z" },
  ];
  const db = captureDatabase(rows);
  const result = await listProducts(db, productQuery("?q=LUXMAN%20L-507Z&limit=1"));

  assert.match(
    db.calls[0].sql,
    /ORDER BY CASE WHEN sp\.manufacturer_id = \? AND sp\.normalized_model = \?/,
  );
  assert.match(db.calls[0].sql, /bm25\(product_search_fts/);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, null);
});

test("newest listing uses activity timestamp with keyset pagination", async () => {
  const rows = [
    { id: 5, last_activity_at: "2026-08-11T03:00:00Z" },
    { id: 4, last_activity_at: "2026-08-11T02:00:00Z" },
    { id: 3, last_activity_at: "2026-08-11T01:00:00Z" },
  ];
  const db = captureDatabase(rows);
  const first = await listProducts(db, productQuery("?sort=newest&limit=2"));

  assert.deepEqual(
    first.items.map((item) => item.id),
    [5, 4],
  );
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.match(db.calls[0].sql, /ORDER BY p\.last_activity_at DESC, p\.id DESC/);
  assert.doesNotMatch(db.calls[0].sql, /OFFSET/);
  assert.doesNotMatch(db.calls[0].sql, /price_history/);
  assert.equal(db.calls[0].binds.at(-1), 3);

  const nextDb = captureDatabase();
  await listProducts(
    nextDb,
    productQuery(`?sort=newest&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`),
  );
  assert.match(nextDb.calls[0].sql, /p\.last_activity_at < \?/);
  assert.deepEqual(nextDb.calls[0].binds.slice(0, 3), [
    "2026-08-11T02:00:00Z",
    "2026-08-11T02:00:00Z",
    4,
  ]);
});

test("oldest listing uses ascending activity timestamp with keyset pagination", async () => {
  const rows = [
    { id: 3, last_activity_at: "2026-08-11T01:00:00Z" },
    { id: 4, last_activity_at: "2026-08-11T02:00:00Z" },
    { id: 5, last_activity_at: "2026-08-11T03:00:00Z" },
  ];
  const db = captureDatabase(rows);
  const first = await listProducts(db, productQuery("?sort=oldest&limit=2"));

  assert.deepEqual(
    first.items.map((item) => item.id),
    [3, 4],
  );
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.match(db.calls[0].sql, /ORDER BY p\.last_activity_at ASC, p\.id ASC/);

  const nextDb = captureDatabase();
  await listProducts(
    nextDb,
    productQuery(`?sort=oldest&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`),
  );
  assert.match(nextDb.calls[0].sql, /p\.last_activity_at > \?/);
  assert.deepEqual(nextDb.calls[0].binds.slice(0, 3), [
    "2026-08-11T02:00:00Z",
    "2026-08-11T02:00:00Z",
    4,
  ]);
});

test("updated sort remains a backward-compatible activity alias", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?sort=updated"));
  assert.match(db.calls[0].sql, /ORDER BY p\.last_activity_at DESC, p\.id DESC/);
});

test("price sorting uses NULLS LAST so the price index can satisfy ordering", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?sort=priceAsc"));
  assert.match(db.calls[0].sql, /ORDER BY p\.price_yen ASC NULLS LAST, p\.id ASC/);
  assert.doesNotMatch(db.calls[0].sql, /price_yen IS NULL ASC/);
});

test("product pagination reports total pages and supports direct offset jumps", async () => {
  const db = captureDatabase((statement) =>
    /COUNT\(\*\) AS total/.test(statement.sql)
      ? [{ total: 5 }]
      : [
          { id: 3, last_activity_at: "2026-08-11T03:00:00Z" },
          { id: 2, last_activity_at: "2026-08-11T02:00:00Z" },
          { id: 1, last_activity_at: "2026-08-11T01:00:00Z" },
        ],
  );

  const result = await listProducts(
    db,
    productQuery("?shop=hifido&sort=newest&limit=2&offset=2&includeTotal=true"),
  );

  assert.equal(result.totalCount, 5);
  assert.equal(result.totalPages, 3);
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.items.map((item) => item.id),
    [3, 2],
  );
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].sql, /COUNT\(\*\) AS total/);
  assert.doesNotMatch(db.calls[0].sql, /OFFSET/);
  assert.deepEqual(db.calls[0].binds, ["hifido"]);
  assert.match(db.calls[1].sql, /LIMIT \? OFFSET \?/);
  assert.deepEqual(db.calls[1].binds, ["hifido", 3, 2]);
});

test("the listing selects explicit product columns instead of SELECT *", async () => {
  const db = captureDatabase();
  await listProducts(db, productQuery("?q=TAD"));

  const { sql } = db.calls[0];
  assert.doesNotMatch(sql, /SELECT p\.\*/);
  assert.match(sql, /SELECT p\.id, p\.shop_key, p\.source_id/);
  assert.match(sql, /p\.category_ids/);
});

test("rows are mapped onto the API item contract, not returned as raw rows", async () => {
  const db = captureDatabase([
    {
      id: 7,
      shop_key: "hifido",
      category_ids: '["speaker","amplifier"]',
      primary_category_id: "speaker",
      price_yen: 1000,
      // A column a future migration might add: it must not reach the payload.
      internal_scoring_hint: "leaked",
    },
  ]);

  const result = await listProducts(db, productQuery(""));

  assert.deepEqual(result.items[0].category_ids, ["speaker", "amplifier"]);
  assert.equal(result.items[0].id, 7);
  assert.ok(!Object.hasOwn(result.items[0], "internal_scoring_hint"));
});

test("a malformed category_ids column falls back to the primary category", async () => {
  const db = captureDatabase([{ id: 8, category_ids: "not json", primary_category_id: "pre_amp" }]);

  const result = await listProducts(db, productQuery(""));

  assert.deepEqual(result.items[0].category_ids, ["pre_amp"]);
});
