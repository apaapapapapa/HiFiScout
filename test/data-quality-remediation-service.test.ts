import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { clearProjectionPendingForToken } from "../src/db/data-quality-remediation-service.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

test("projection cleanup never clears a newer replay token", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      remediation_projection_required INTEGER NOT NULL,
      remediation_projection_token TEXT NOT NULL
    );
    INSERT INTO products(id, remediation_projection_required, remediation_projection_token)
    VALUES (1, 1, 'newer-token');
  `);
  const db = sqliteD1(sqlite);

  const staleCleanup = await clearProjectionPendingForToken(db, 1, "older-token");
  assert.equal(staleCleanup, false);
  assert.deepEqual(
    sqlite
      .prepare(
        "SELECT remediation_projection_required, remediation_projection_token FROM products WHERE id = 1",
      )
      .get(),
    { remediation_projection_required: 1, remediation_projection_token: "newer-token" },
  );

  const ownerCleanup = await clearProjectionPendingForToken(db, 1, "newer-token");
  assert.equal(ownerCleanup, true);
  assert.deepEqual(
    sqlite
      .prepare(
        "SELECT remediation_projection_required, remediation_projection_token FROM products WHERE id = 1",
      )
      .get(),
    { remediation_projection_required: 0, remediation_projection_token: "" },
  );
});
