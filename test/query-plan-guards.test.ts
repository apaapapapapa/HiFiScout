import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { assertNoGrowingTableScans, fullScans } from "./helpers/query-plan.js";

test("indexed full scans are rejected unless the individual statement declares its cost", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    "CREATE TABLE growing(id INTEGER PRIMARY KEY, value INTEGER); CREATE INDEX values_idx ON growing(value)",
  );
  const aggregate = { sql: "SELECT value, COUNT(*) FROM growing GROUP BY value", binds: [] };
  assert.throws(() => assertNoGrowingTableScans(sqlite, [aggregate]), /full table read of growing/);
  assertNoGrowingTableScans(sqlite, [aggregate], {
    allowances: [
      {
        tables: ["growing"],
        when: /GROUP BY value/,
        reason: "This explicit aggregate intentionally visits all index entries",
      },
    ],
  });
  assert.throws(
    () =>
      assertNoGrowingTableScans(
        sqlite,
        [aggregate, { sql: "SELECT value FROM growing", binds: [] }],
        {
          allowances: [
            {
              tables: ["growing"],
              when: /GROUP BY value/,
              reason: "Only the aggregate is allowed",
            },
          ],
        },
      ),
    /full table read of growing/,
  );
  assert.deepEqual(fullScans([{ detail: "SCAN fts VIRTUAL TABLE INDEX 0:M1" }]), []);
  assert.deepEqual(fullScans([{ detail: "SCAN fts VIRTUAL TABLE INDEX 0:" }]), ["fts"]);
});
