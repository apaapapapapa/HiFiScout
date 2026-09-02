import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const LEGACY_COLUMNS = [
  "queued_at",
  "queued_token",
  "queued_last_sent_at",
  "crawl_lease_token",
  "crawl_lease_until",
] as const;

const DISPATCH_COLUMNS = [
  "dispatch_requested_at",
  "dispatch_token",
  "dispatch_last_sent_at",
] as const;

const BRIDGE_TRIGGERS = [
  "trg_shop_sync_state_legacy_dispatch_insert",
  "trg_shop_sync_state_legacy_dispatch_update",
  "trg_shop_sync_state_dispatch_legacy_insert",
  "trg_shop_sync_state_dispatch_legacy_update",
] as const;

test("Phase 7 production schema keeps dispatch state and physically removes Queue-era crawl state", () => {
  const { sqlite } = migratedSqlite();
  const columns = new Set(
    (
      sqlite.prepare("PRAGMA table_info(shop_sync_state)").all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );

  for (const column of DISPATCH_COLUMNS) assert.equal(columns.has(column), true, column);
  for (const column of LEGACY_COLUMNS) assert.equal(columns.has(column), false, column);

  const legacyObjects = sqlite
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE name = 'idx_shop_sync_state_queued_at'
          OR name IN (?, ?, ?, ?)`,
    )
    .all(...BRIDGE_TRIGGERS) as unknown as Array<{ name: string }>;
  assert.deepEqual(legacyObjects, []);
});

test("production provisioning retains only the non-crawl Queue data plane", () => {
  const script = readFileSync(
    new URL("../scripts/provision-production-resources.sh", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(script, /hifiscout-crawl(?:-|\b)/);
  assert.match(script, /hifiscout-knowledge-verification/);
  assert.match(script, /hifiscout-product-audit-export/);
});

test("the crawl Queue consumer compatibility entry point is retired", () => {
  assert.equal(
    existsSync(new URL("../src/crawler/resumable-queue-consumer.ts", import.meta.url)),
    false,
  );
});
