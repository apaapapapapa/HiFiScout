import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { clearProjectionPendingForToken } from "../src/db/data-quality-remediation-service.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

interface ProjectionState {
  remediation_projection_required: number;
  remediation_projection_token: string;
}

function projectionState(sqlite: DatabaseSync): ProjectionState {
  const row = sqlite
    .prepare(
      "SELECT remediation_projection_required, remediation_projection_token FROM products WHERE id = 1",
    )
    .get() as unknown as ProjectionState;
  return row;
}

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
  const afterStaleCleanup = projectionState(sqlite);
  assert.equal(afterStaleCleanup.remediation_projection_required, 1);
  assert.equal(afterStaleCleanup.remediation_projection_token, "newer-token");

  const ownerCleanup = await clearProjectionPendingForToken(db, 1, "newer-token");
  assert.equal(ownerCleanup, true);
  const afterOwnerCleanup = projectionState(sqlite);
  assert.equal(afterOwnerCleanup.remediation_projection_required, 0);
  assert.equal(afterOwnerCleanup.remediation_projection_token, "");
});
