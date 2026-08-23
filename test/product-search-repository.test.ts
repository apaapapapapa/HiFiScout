import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { productSearchDetail, searchProducts } from "../src/db/product-search-repository.js";
import { captureDatabase } from "./helpers/d1.js";
import { entityRow, offerRow } from "./helpers/product-search.js";
import { productQuery } from "./helpers/product-query.js";
import type { CapturedStatement } from "./helpers/d1.js";

/** The page query is the one that selects entity columns; offer queries come after it. */
function pageCall(calls: readonly CapturedStatement[]): CapturedStatement {
  const call = calls.find((statement) => /SELECT e\.id, e\.entity_key/.test(statement.sql));
  assert.ok(call, "expected an entity page query");
  return call;
}

test("TAD 1000 uses the product entity FTS5 index conjunctively", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?q=TAD%201000&limit=50"));

  const { sql, binds } = pageCall(db.calls);
  assert.match(sql, /FROM product_search_entities e/);
  assert.match(sql, /JOIN product_search_entities_fts/);
  assert.match(sql, /product_search_entities_fts MATCH \?/);
  assert.equal(binds[0], '"TAD" AND "1000"');
  assert.doesNotMatch(sql, /FROM products p/);
});

test("short search tokens are ANDed through entity LIKE without bypassing FTS terms", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?q=SE%20TAD&sort=newest"));

  const { sql, binds } = pageCall(db.calls);
  assert.match(sql, /product_search_entities_fts MATCH \?/);
  assert.equal(binds[0], '"TAD"');
  assert.ok(binds.includes("%SE%"));
});

test("a search too short for the tokenizer still scans the entity terms", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?q=MC"));

  const { sql, binds } = pageCall(db.calls);
  assert.match(sql, /FROM product_search_entities e/);
  assert.doesNotMatch(sql, /MATCH/);
  assert.match(sql, /e\.manufacturer_terms LIKE \?/);
  assert.match(sql, /e\.title_terms LIKE \?/);
  assert.match(sql, /e\.category_terms LIKE \?/);
  assert.equal(binds.filter((value) => value === "%MC%").length, 5);
});

test("relevance ranks exact identity matches ahead of bm25 and never counts offers", async () => {
  const db = captureDatabase([entityRow({ id: 5 }), entityRow({ id: 4 })]);
  const result = await searchProducts(db, productQuery("?q=LUXMAN%20L-507Z&limit=1"));

  const { sql } = pageCall(db.calls);
  assert.match(sql, /ORDER BY CASE WHEN e\.manufacturer_id = \? AND e\.normalized_model = \?/);
  assert.match(sql, /bm25\(product_search_entities_fts/);
  assert.doesNotMatch(sql, /offer_count (?:ASC|DESC)/);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, null);
});

test("explicit sort keeps stable keyset ordering instead of relevance offset mode", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?q=TAD%201000&sort=newest"));

  const { sql } = pageCall(db.calls);
  assert.match(sql, /ORDER BY e\.newest_listed_at DESC NULLS LAST, e\.id DESC/);
  assert.doesNotMatch(sql, /bm25/);
});

test("newest orders by the product's newest offer and pages with a product cursor", async () => {
  const rows = [
    entityRow({ id: 5, newest_listed_at: "2026-08-11T03:00:00Z" }),
    entityRow({ id: 4, newest_listed_at: "2026-08-11T02:00:00Z" }),
    entityRow({ id: 3, newest_listed_at: "2026-08-11T01:00:00Z" }),
  ];
  const db = captureDatabase(rows);
  const first = await searchProducts(db, productQuery("?sort=newest&limit=2&inStock=false"));

  assert.deepEqual(
    first.items.map((item) => item.key),
    ["c-5", "c-4"],
  );
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.match(pageCall(db.calls).sql, /ORDER BY e\.newest_listed_at DESC NULLS LAST, e\.id DESC/);

  const nextDb = captureDatabase();
  await searchProducts(
    nextDb,
    productQuery(
      `?sort=newest&limit=2&inStock=false&cursor=${encodeURIComponent(first.nextCursor)}`,
    ),
  );
  const { sql, binds } = pageCall(nextDb.calls);
  assert.match(sql, /e\.newest_listed_at < \?/);
  assert.deepEqual(binds.slice(0, 3), ["2026-08-11T02:00:00Z", "2026-08-11T02:00:00Z", 4]);
});

test("a multi-shop product takes one slot on the page, and only that page loads offers", async () => {
  const db = captureDatabase((statement) =>
    /SELECT e\.id, e\.entity_key/.test(statement.sql)
      ? [
          entityRow({ id: 1, offer_count: 4, shop_count: 3 }),
          entityRow({ id: 2, offer_count: 1, shop_count: 1 }),
          entityRow({ id: 3, offer_count: 2, shop_count: 2 }),
        ]
      : [],
  );

  const result = await searchProducts(db, productQuery("?limit=2&sort=newest&inStock=false"));

  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map((item) => item.key),
    ["c-1", "c-2"],
  );
  // The extra row only decides `hasMore`; it must not be loaded as an offer or shown as a result.
  assert.equal(result.hasMore, true);
  assert.equal(pageCall(db.calls).binds.at(-1), 3);
  const offerQuery = db.calls.find((statement) => /m\.entity_id IN \(/.test(statement.sql));
  assert.ok(offerQuery);
  assert.deepEqual(offerQuery.binds, [1, 2]);
});

test("oldest is the exact inverse of newest rather than a different aggregate", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?sort=oldest&limit=2"));
  assert.match(pageCall(db.calls).sql, /ORDER BY e\.newest_listed_at ASC NULLS LAST, e\.id ASC/);
});

test("updated orders by the latest activity across the product's offers", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?sort=updated"));
  assert.match(pageCall(db.calls).sql, /ORDER BY e\.latest_activity_at DESC NULLS LAST/);
});

test("price sorting follows the in-stock aggregate whenever in-stock offers were requested", async () => {
  const inStock = captureDatabase();
  await searchProducts(inStock, productQuery("?sort=priceAsc&inStock=true"));
  assert.match(
    pageCall(inStock.calls).sql,
    /ORDER BY e\.lowest_in_stock_price_yen ASC NULLS LAST, e\.id ASC/,
  );

  const anyStock = captureDatabase();
  await searchProducts(anyStock, productQuery("?sort=priceAsc"));
  assert.match(pageCall(anyStock.calls).sql, /ORDER BY e\.lowest_price_yen ASC NULLS LAST/);
});

test("a cursor minted under one price aggregate is ignored by the other", async () => {
  const rows = [
    entityRow({ id: 9, lowest_in_stock_price_yen: 1000 }),
    entityRow({ id: 8, lowest_in_stock_price_yen: 2000 }),
    entityRow({ id: 7, lowest_in_stock_price_yen: 3000 }),
  ];
  const db = captureDatabase(rows);
  const first = await searchProducts(db, productQuery("?sort=priceAsc&inStock=true&limit=2"));
  assert.ok(first.nextCursor);

  const reused = captureDatabase();
  await searchProducts(
    reused,
    productQuery(`?sort=priceAsc&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`),
  );
  assert.doesNotMatch(pageCall(reused.calls).sql, /e\.lowest_price_yen [<>] \?/);
});

test("totals count products, and offsets page over products", async () => {
  const db = captureDatabase((statement) =>
    /COUNT\(\*\) AS total/.test(statement.sql)
      ? [{ total: 5 }]
      : /SELECT e\.id, e\.entity_key/.test(statement.sql)
        ? [entityRow({ id: 3 }), entityRow({ id: 2 }), entityRow({ id: 1 })]
        : [],
  );

  const result = await searchProducts(
    db,
    productQuery("?shop=hifido&sort=newest&limit=2&offset=2&includeTotal=true&inStock=false"),
  );

  assert.equal(result.totalCount, 5);
  assert.equal(result.totalPages, 3);
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.items.map((item) => item.key),
    ["c-3", "c-2"],
  );
  assert.match(db.calls[0].sql, /COUNT\(\*\) AS total FROM product_search_entities e/);
  assert.doesNotMatch(db.calls[0].sql, /OFFSET/);
  assert.match(pageCall(db.calls).sql, /LIMIT \? OFFSET \?/);
});

test("offer summary and representative offer cost two bounded queries, not one per result", async () => {
  const db = captureDatabase((statement) =>
    /SELECT e\.id, e\.entity_key/.test(statement.sql)
      ? [entityRow({ id: 1 }), entityRow({ id: 2 }), entityRow({ id: 3 })]
      : [],
  );
  await searchProducts(db, productQuery("?inStock=true"));

  const offerQueries = db.calls.filter((statement) => /m\.entity_id IN \(/.test(statement.sql));
  assert.equal(offerQueries.length, 2);
  for (const statement of offerQueries) {
    assert.match(statement.sql, /m\.entity_id IN \(\?,\?,\?\)/);
    assert.match(statement.sql, /p\.stock_status = 'in_stock'/);
  }
  assert.match(offerQueries[1].sql, /ROW_NUMBER\(\) OVER/);
});

test("a full page stays inside D1's bound-parameter limit without going per-result", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => entityRow({ id: index + 1 }));
  const db = captureDatabase((statement) =>
    /SELECT e\.id, e\.entity_key/.test(statement.sql) ? rows : [],
  );

  const result = await searchProducts(db, productQuery("?limit=100&shop=hifido&inStock=true"));

  assert.equal(result.items.length, 100);
  const offerQueries = db.calls.filter((statement) => /m\.entity_id IN \(/.test(statement.sql));
  // Bounded by the page size, not by the result count: three chunks per loader, never 100 queries.
  assert.equal(offerQueries.length, 6);
  for (const statement of offerQueries) {
    assert.ok(statement.binds.length <= 100, `${statement.binds.length} binds`);
  }
});

test("no offer filters means the stored aggregates are already the right summary", async () => {
  const db = captureDatabase((statement) =>
    /SELECT e\.id, e\.entity_key/.test(statement.sql) ? [entityRow({ id: 1 })] : [],
  );
  await searchProducts(db, productQuery(""));

  const offerQueries = db.calls.filter((statement) => /m\.entity_id IN \(/.test(statement.sql));
  assert.equal(offerQueries.length, 1);
  assert.match(offerQueries[0].sql, /ROW_NUMBER\(\) OVER/);
});

test("the card summary is recomputed from the offers that matched the filter", async () => {
  const db = captureDatabase((statement) => {
    if (/SELECT e\.id, e\.entity_key/.test(statement.sql)) {
      return [entityRow({ id: 7, offer_count: 4, shop_count: 3, lowest_price_yen: 50_000 })];
    }
    if (/ROW_NUMBER\(\) OVER/.test(statement.sql)) {
      return [{ entity_id: 7, ...offerRow({ shop_key: "hifido", price_yen: 120_000 }) }];
    }
    return [
      {
        entity_id: 7,
        offer_count: 1,
        in_stock_offer_count: 1,
        sold_out_offer_count: 0,
        shop_count: 1,
        lowest_price_yen: 120_000,
        highest_price_yen: 120_000,
        latest_activity_at: "2026-08-12T00:00:00Z",
        newest_listed_at: "2026-08-12T00:00:00Z",
        has_price_drop: 0,
      },
    ];
  });

  const result = await searchProducts(db, productQuery("?shop=hifido&inStock=true"));
  const aggregateQuery = db.calls.find((statement) =>
    /AS sold_out_offer_count/.test(statement.sql),
  );

  assert.ok(aggregateQuery);
  assert.equal(result.items[0].offer_count, 1);
  assert.equal(result.items[0].sold_out_offer_count, 0);
  assert.equal(result.items[0].shop_count, 1);
  assert.equal(result.items[0].lowest_price_yen, 120_000);
  assert.equal(result.items[0].representative_offer?.shop_key, "hifido");
});

test("entity rows are mapped onto the API item contract, not returned raw", async () => {
  const db = captureDatabase((statement) =>
    /SELECT e\.id, e\.entity_key/.test(statement.sql)
      ? [entityRow({ id: 7, primary_category_id: "pre_amp", internal_scoring_hint: "leaked" })]
      : [],
  );

  const result = await searchProducts(db, productQuery(""));

  assert.equal(result.items[0].key, "c-7");
  assert.equal(result.items[0].identity_kind, "catalog");
  assert.equal(result.items[0].category, "プリアンプ");
  assert.ok(!Object.hasOwn(result.items[0], "internal_scoring_hint"));
  assert.ok(!Object.hasOwn(result.items[0], "id"));
});

test("the page selects explicit entity columns instead of SELECT *", async () => {
  const db = captureDatabase();
  await searchProducts(db, productQuery("?q=TAD"));

  const { sql } = pageCall(db.calls);
  assert.doesNotMatch(sql, /SELECT e\.\*/);
  assert.match(sql, /SELECT e\.id, e\.entity_key, e\.entity_kind/);
});

test("product detail returns every eligible offer under one bounded query", async () => {
  const db = captureDatabase((statement) =>
    /FROM product_search_entities e WHERE e\.entity_key/.test(statement.sql)
      ? [entityRow({ id: 12, entity_key: "c-12", offer_count: 2, shop_count: 2 })]
      : [
          offerRow({ listing_product_id: 100, shop_key: "hifido", price_yen: 300_000 }),
          offerRow({ listing_product_id: 200, shop_key: "ippinkan", price_yen: 320_000 }),
        ],
  );

  const detail = await productSearchDetail(db, "c-12");

  assert.ok(detail);
  assert.equal(detail.product.key, "c-12");
  assert.equal(detail.offers.length, 2);
  assert.deepEqual(
    detail.offers.map((offer) => offer.shop_key),
    ["hifido", "ippinkan"],
  );
  assert.equal(detail.product.representative_offer?.listing_product_id, 100);
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[1].sql, /LIMIT \?/);
});

test("a malformed product key is rejected before any query runs", async () => {
  const db = captureDatabase();
  assert.equal(await productSearchDetail(db, "c-12; DROP TABLE products"), null);
  assert.equal(await productSearchDetail(db, "legacy-9"), null);
  assert.equal(db.calls.length, 0);
});

test("an unknown product key answers with no detail rather than an empty product", async () => {
  const db = captureDatabase([]);
  assert.equal(await productSearchDetail(db, "c-999"), null);
});
