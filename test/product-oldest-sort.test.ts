import test from "node:test";
import assert from "node:assert/strict";
import { listProducts, validateProductQuery } from "../src/db/products.js";

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

test("oldest sort is accepted by product query validation", () => {
  assert.equal(
    validateProductQuery(new URL("https://example.test/api/products?sort=oldest")),
    null,
  );
});

test("oldest listing uses ascending activity timestamp with keyset pagination", async () => {
  const rows = [
    { id: 3, last_activity_at: "2026-08-11T01:00:00Z" },
    { id: 4, last_activity_at: "2026-08-11T02:00:00Z" },
    { id: 5, last_activity_at: "2026-08-11T03:00:00Z" },
  ];
  const db = queryCaptureDb(rows);
  const first = await listProducts(
    db,
    new URL("https://example.test/api/products?sort=oldest&limit=2"),
  );

  assert.deepEqual(
    first.items.map((row) => row.id),
    [3, 4],
  );
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.match(db.calls[0].sql, /ORDER BY p\.last_activity_at ASC, p\.id ASC/);

  const nextDb = queryCaptureDb([]);
  await listProducts(
    nextDb,
    new URL(
      `https://example.test/api/products?sort=oldest&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
    ),
  );
  assert.match(nextDb.calls[0].sql, /p\.last_activity_at > \?/);
  assert.deepEqual(nextDb.calls[0].binds.slice(0, 3), [
    "2026-08-11T02:00:00Z",
    "2026-08-11T02:00:00Z",
    4,
  ]);
});
