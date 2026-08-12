import test from "node:test";
import assert from "node:assert/strict";
import { listProducts, validateProductQuery } from "../src/db/products.js";

function paginationDb({ total = 5, rows = [] } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...binds) {
          calls.push({ sql, binds });
          return {
            async all() {
              if (/COUNT\(\*\) AS total/.test(sql)) return { results: [{ total }] };
              return { results: rows };
            },
          };
        },
      };
    },
  };
}

test("product pagination reports total pages and supports direct offset jumps", async () => {
  const db = paginationDb({
    total: 5,
    rows: [
      { id: 3, last_activity_at: "2026-08-11T03:00:00Z" },
      { id: 2, last_activity_at: "2026-08-11T02:00:00Z" },
      { id: 1, last_activity_at: "2026-08-11T01:00:00Z" },
    ],
  });

  const result = await listProducts(
    db,
    new URL(
      "https://example.test/api/products?shop=hifido&sort=newest&limit=2&offset=2&includeTotal=true",
    ),
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

test("pagination query validation covers offset and total-count flags", () => {
  assert.equal(
    validateProductQuery(new URL("https://example.test/api/products?offset=-1")),
    "offset_invalid",
  );
  assert.equal(
    validateProductQuery(new URL("https://example.test/api/products?includeTotal=yes")),
    "includeTotal_invalid",
  );
  assert.equal(
    validateProductQuery(new URL("https://example.test/api/products?offset=100&includeTotal=true")),
    null,
  );
});
