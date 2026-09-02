import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("Phase 7 runtime has no Queue-era crawl lease or shadow control path", () => {
  const repository = source("../src/db/shop-state-repository.ts");
  const scheduler = source("../src/crawler/crawl-scheduler-do.ts");
  const orchestration = source("../src/crawler/orchestration.ts");
  const executor = source("../src/crawler/resumable-crawl-executor.ts");

  assert.doesNotMatch(repository, /queued_at|queued_token|queued_last_sent_at|crawl_lease_/);
  assert.doesNotMatch(
    repository,
    /tryClaimShopCrawl|releaseShopCrawl|markShopQueued|clearShopQueued/,
  );
  assert.doesNotMatch(scheduler, /observe-checkpoint|shadow|canary/i);
  assert.doesNotMatch(orchestration, /observe-checkpoint|shadow|canary/i);
  assert.doesNotMatch(executor, /tryClaimShopCrawl|crawl_lease_/);

  assert.match(repository, /dispatch_requested_at/);
  assert.match(repository, /dispatch_token/);
  assert.match(scheduler, /setAlarm/);
  assert.doesNotMatch(scheduler, /\bsleep\s*\(/);
});

test("Phase 7 bridge fences both old and new Workers during migration-first deploy", () => {
  const migration = source("../migrations/0072_crawl_dispatch_state.sql");

  assert.match(migration, /trg_shop_sync_state_legacy_dispatch_update/);
  assert.match(migration, /trg_shop_sync_state_dispatch_legacy_update/);
  assert.match(migration, /SET dispatch_requested_at = NEW\.queued_at/);
  assert.match(migration, /SET queued_at = NEW\.dispatch_requested_at/);
  assert.match(migration, /NEW\.queued_at IS NOT NEW\.dispatch_requested_at/);
});
