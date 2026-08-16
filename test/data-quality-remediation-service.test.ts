import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  clearProjectionPendingForToken,
  refreshRemediationShopProjections,
  type ListingProjectionRefresher,
} from "../src/db/data-quality-remediation-service.js";
import { sqliteD1 } from "./helpers/sqlite-d1.js";

interface ProjectionState {
  remediation_projection_required: number;
  remediation_projection_token: string;
}

function projectionState(sqlite: DatabaseSync, id = 1): ProjectionState {
  const row = sqlite
    .prepare(
      "SELECT remediation_projection_required, remediation_projection_token FROM products WHERE id = ?",
    )
    .get(id) as unknown as ProjectionState;
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

test("shop remediation refresh batches every source before clearing owned projection tokens", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      remediation_projection_required INTEGER NOT NULL,
      remediation_projection_token TEXT NOT NULL
    );
    INSERT INTO products(id, remediation_projection_required, remediation_projection_token) VALUES
      (1, 1, 'token-1'),
      (2, 1, 'token-2');
  `);
  const db = sqliteD1(sqlite);
  const calls: Array<{
    listings: Array<{ shop_key: string; source_id: string }>;
    evaluatedAt: string;
  }> = [];
  const refresh: ListingProjectionRefresher = async (_db, listings, evaluatedAt) => {
    calls.push({ listings: [...listings], evaluatedAt });
  };

  await refreshRemediationShopProjections(
    db,
    "shop-a",
    [
      { listingProductId: 1, sourceId: "source-1", projectionToken: "token-1" },
      { listingProductId: 2, sourceId: "source-2", projectionToken: "token-2" },
    ],
    "2026-08-16T00:00:00.000Z",
    refresh,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    listings: [
      { shop_key: "shop-a", source_id: "source-1" },
      { shop_key: "shop-a", source_id: "source-2" },
    ],
    evaluatedAt: "2026-08-16T00:00:00.000Z",
  });
  assert.deepEqual(projectionState(sqlite, 1), {
    remediation_projection_required: 0,
    remediation_projection_token: "",
  });
  assert.deepEqual(projectionState(sqlite, 2), {
    remediation_projection_required: 0,
    remediation_projection_token: "",
  });
});
