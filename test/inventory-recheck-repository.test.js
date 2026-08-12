import test from "node:test";
import assert from "node:assert/strict";
import {
  markInventoryAvailable,
  recordInventoryUnavailable,
  selectInventoryRecheckCandidate,
} from "../src/db/inventory-recheck-repository.js";

function captureDb(firstResult = null) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...binds) {
          calls.push({ sql, binds });
          return {
            async first() {
              return firstResult;
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

test("candidate selection requires an old listing and a stale prior attempt", async () => {
  const row = { id: 1, source_id: "123" };
  const db = captureDb(row);
  const result = await selectInventoryRecheckCandidate(db, "audiounion", {
    staleBefore: "2026-08-10T10:00:00.000Z",
    retryBefore: "2026-08-10T10:00:00.000Z",
  });

  assert.equal(result, row);
  assert.deepEqual(db.calls[0].binds, [
    "audiounion",
    "2026-08-10T10:00:00.000Z",
    "2026-08-10T10:00:00.000Z",
  ]);
  assert.match(db.calls[0].sql, /is_active = 1/);
  assert.match(db.calls[0].sql, /last_seen_at <= \?/);
  assert.match(db.calls[0].sql, /last_inventory_check_attempt_at IS NULL/);
  assert.match(db.calls[0].sql, /LIMIT 1/);
});

test("available verification resets failures without touching listing last_seen_at", async () => {
  const db = captureDb();
  await markInventoryAvailable(db, 9, "2026-08-11T10:00:00.000Z");

  assert.match(db.calls[0].sql, /inventory_check_failures = 0/);
  assert.match(db.calls[0].sql, /stock_status = 'in_stock'/);
  assert.doesNotMatch(db.calls[0].sql, /last_seen_at\s*=/);
});

test("unavailable verification only deactivates when the caller reaches its threshold", async () => {
  const keepDb = captureDb();
  await recordInventoryUnavailable(keepDb, 9, "2026-08-11T10:00:00.000Z", 1, false);
  assert.deepEqual(keepDb.calls[0].binds.slice(0, 7), [
    "2026-08-11T10:00:00.000Z",
    "2026-08-11T10:00:00.000Z",
    1,
    0,
    0,
    0,
    "2026-08-11T10:00:00.000Z",
  ]);

  const deactivateDb = captureDb();
  await recordInventoryUnavailable(deactivateDb, 9, "2026-08-12T10:00:00.000Z", 2, true);
  assert.deepEqual(deactivateDb.calls[0].binds.slice(0, 7), [
    "2026-08-12T10:00:00.000Z",
    "2026-08-12T10:00:00.000Z",
    2,
    1,
    1,
    1,
    "2026-08-12T10:00:00.000Z",
  ]);
  assert.match(deactivateDb.calls[0].sql, /stock_status = CASE WHEN \? = 1 THEN 'sold_out'/);
  assert.match(deactivateDb.calls[0].sql, /is_active = CASE WHEN \? = 1 THEN 0/);
});
