import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import {
  isKnowledgeCatalogQueueDailyWriteLimit,
  shouldDeferKnowledgeCatalogQueueQuotaRecovery,
} from "../src/knowledge-catalog/queue-write-quota.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const scheduledSource = readFileSync(new URL("../src/scheduled.ts", import.meta.url), "utf8");
const gapRepairSource = readFileSync(
  new URL("../src/db/product-search-gap-repair.ts", import.meta.url),
  "utf8",
);
const wranglerSource = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

test("daily Queues write quota failures wait only until the next UTC quota day", async () => {
  const { sqlite, db } = migratedSqlite();
  sqlite
    .prepare(`
      INSERT INTO knowledge_catalog_review_runs(started_at, finished_at, status, message)
      VALUES (?, ?, 'failed', ?)
    `)
    .run(
      "2026-08-31T22:36:15.250Z",
      "2026-08-31T22:37:28.406Z",
      "knowledge_catalog_recovery_dispatch_failed:You have exceeded the daily write operations limit in Queues free tier (10253)",
    );
  const runId = Number(
    sqlite.prepare("SELECT MAX(id) AS id FROM knowledge_catalog_review_runs").get()?.id || 0,
  );

  assert.equal(
    isKnowledgeCatalogQueueDailyWriteLimit(
      "knowledge_catalog_recovery_dispatch_failed:You have exceeded the daily write operations limit in Queues free tier (10253)",
    ),
    true,
  );
  assert.equal(
    await shouldDeferKnowledgeCatalogQueueQuotaRecovery(
      db,
      runId,
      "You have exceeded the daily write operations limit in Queues free tier (10253)",
      new Date("2026-08-31T23:59:59.000Z"),
    ),
    true,
  );
  assert.equal(
    await shouldDeferKnowledgeCatalogQueueQuotaRecovery(
      db,
      runId,
      "You have exceeded the daily write operations limit in Queues free tier (10253)",
      new Date("2026-09-01T00:00:00.000Z"),
    ),
    false,
  );
});

test("Knowledge Catalog recovery is bounded and rechecked on every five-minute cron tick", () => {
  assert.match(
    wranglerSource,
    /"queue": "hifiscout-knowledge-verification", "max_batch_size": 1, "max_batch_timeout": 1, "max_retries": 8,[^\n]+"max_concurrency": 1/u,
  );
  assert.doesNotMatch(
    wranglerSource,
    /"queue": "hifiscout-knowledge-verification"[^\n]+"max_retries": 100/u,
  );
  assert.match(scheduledSource, /name: "knowledge_catalog_queue_quota_recovery",\s+everyTicks: 1/u);
  assert.match(scheduledSource, /shouldDeferKnowledgeCatalogQueueQuotaRecovery\(/u);
  assert.match(scheduledSource, /reason: "knowledge_catalog_queue_daily_write_limit"/u);
});

test("stale fallback repair goes directly to transactional entity membership sync", () => {
  assert.match(
    gapRepairSource,
    /import \{ syncProductSearchEntities \} from "\.\/product-search-entity-repository\.js"/u,
  );
  assert.match(
    gapRepairSource,
    /repairPhase\(STALE_FALLBACK_GAP_PREDICATE, refreshStaleFallbackMembershipOnly\)/u,
  );
  assert.match(gapRepairSource, /await syncProductSearchEntities\(db, shopKey, sourceIds\)/u);
});
