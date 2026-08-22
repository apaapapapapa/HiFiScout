import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SHOP_DEFINITIONS, getShopEnabled, getShopRequestDelayMs } from "../src/config.js";
import { isShopDue, isSuspiciousItemDrop } from "../src/crawler/run.js";
import {
  sharedSweepExclusions,
  shopForCron,
  shopsWithDedicatedCron,
} from "../src/crawler/schedule.js";
import {
  DAILY_MAINTENANCE_CRON,
  GENERAL_CRON,
  KNOWLEDGE_CATALOG_MONTHLY_CRON,
} from "../src/scheduled.js";

const wranglerConfig = JSON.parse(
  fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const schedulerSource = fs.readFileSync(new URL("../src/scheduled.ts", import.meta.url), "utf8");
const provisionProductionResources = fs.readFileSync(
  new URL("../scripts/provision-production-resources.sh", import.meta.url),
  "utf8",
);

test("shop interval is evaluated independently", () => {
  const now = new Date("2026-08-11T00:30:00.000Z");
  assert.equal(isShopDue({ last_attempt_at: "2026-08-11T00:00:00.000Z" }, 30, now), true);
  assert.equal(isShopDue({ last_attempt_at: "2026-08-11T00:10:00.000Z" }, 30, now), false);
  assert.equal(isShopDue({ last_attempt_at: "2026-08-11T00:00:00.000Z" }, 60, now), false);
});

test("shop kill switch defaults on and can disable a collector", () => {
  const shop = SHOP_DEFINITIONS.hifido;
  assert.equal(getShopEnabled({}, shop), true);
  assert.equal(getShopEnabled({ HIFIDO_ENABLED: "false" }, shop), false);
  assert.equal(getShopEnabled({ HIFIDO_ENABLED: "0" }, shop), false);
});

test("shop request delay overrides the global fallback", () => {
  assert.equal(getShopRequestDelayMs({}, SHOP_DEFINITIONS.audiounion, 1200), 10_000);
  assert.equal(
    getShopRequestDelayMs(
      { AUDIOUNION_REQUEST_DELAY_MS: "15000" },
      SHOP_DEFINITIONS.audiounion,
      1200,
    ),
    15_000,
  );
  assert.equal(getShopRequestDelayMs({}, SHOP_DEFINITIONS.ippinkan, 1200), 1200);
});

test("a dedicated shop cron is declared in wrangler and owns that shop alone", () => {
  const crons: string[] = wranglerConfig.triggers?.crons || [];
  const dedicated = shopsWithDedicatedCron();
  assert.ok(dedicated.length > 0);

  for (const plugin of dedicated) {
    const cron = plugin.definition.scheduleCron;
    assert.ok(cron);
    assert.ok(crons.includes(cron), `${plugin.key} cron ${cron} is missing from wrangler.jsonc`);
    assert.equal(shopForCron(cron), plugin);
  }
});

test("the shared sweep skips exactly the shops that own a cron", () => {
  assert.deepEqual(
    [...sharedSweepExclusions()].sort(),
    shopsWithDedicatedCron()
      .map((plugin) => plugin.key)
      .sort(),
  );
  // Non-crawl crons must fall through to the shared sweep rather than dispatching a shop.
  assert.equal(shopForCron("*/5 * * * *"), null);
  assert.equal(shopForCron("17 18 * * *"), null);
  assert.equal(shopForCron(""), null);
});

test("scheduled crawl dispatch is resolved by policy rather than by shop name", () => {
  assert.match(schedulerSource, /shopForCron\(cron\)/);
  assert.match(schedulerSource, /sharedSweepExclusions\(\)/);
});

test("every cron the scheduler handles is declared in wrangler, and vice versa", () => {
  const crons: string[] = wranglerConfig.triggers?.crons || [];
  const handled = [
    GENERAL_CRON,
    DAILY_MAINTENANCE_CRON,
    KNOWLEDGE_CATALOG_MONTHLY_CRON,
    ...shopsWithDedicatedCron().map((plugin) => plugin.definition.scheduleCron),
  ];

  assert.deepEqual([...crons].sort(), [...handled].sort());
});

test("large item-count drops are rejected only after a meaningful baseline", () => {
  assert.equal(isSuspiciousItemDrop(49, 100, { minRatio: 0.5, minBaseline: 20 }), true);
  assert.equal(isSuspiciousItemDrop(50, 100, { minRatio: 0.5, minBaseline: 20 }), false);
  assert.equal(isSuspiciousItemDrop(1, 10, { minRatio: 0.5, minBaseline: 20 }), false);
});

test("Knowledge Catalog verification is dispatched to its dedicated queue", () => {
  const crons = wranglerConfig.triggers?.crons || [];
  assert.equal(crons.length, 5);
  assert.ok(crons.includes("17 18 * * *"));
  assert.ok(crons.includes("23 3 1 * *"));
  assert.ok(!crons.includes("43 4 * * *"));
  assert.match(schedulerSource, /runDailyMaintenance\(env\)/);
  assert.match(schedulerSource, /runRetentionCleanup\(env\)/);
  assert.match(schedulerSource, /dispatchKnowledgeCatalogDailyVerification\(env\)/);
  assert.match(schedulerSource, /dispatchKnowledgeCatalogMonthlyRecheck\(env\)/);
  assert.equal(wranglerConfig.vars.KNOWLEDGE_CATALOG_DAILY_VERIFY_MAX_CANDIDATES, "200");
  assert.equal(wranglerConfig.vars.KNOWLEDGE_CATALOG_REVIEW_INTERVAL_DAYS, "30");

  const producer = wranglerConfig.queues.producers.find(
    (item: { binding?: string }) => item.binding === "KNOWLEDGE_CATALOG_QUEUE",
  );
  assert.equal(producer?.queue, "hifiscout-knowledge-verification");
  const consumer = wranglerConfig.queues.consumers.find(
    (item: { queue?: string }) => item.queue === "hifiscout-knowledge-verification",
  );
  assert.equal(consumer?.max_batch_size, 1);
  assert.equal(consumer?.max_concurrency, 4);
  assert.equal(consumer?.dead_letter_queue, "hifiscout-knowledge-verification-dlq");
});

test("admin CSV exports share the existing serialized Product Audit queue", () => {
  const producer = wranglerConfig.queues.producers.find(
    (item: { binding?: string }) => item.binding === "PRODUCT_AUDIT_EXPORT_QUEUE",
  );
  assert.equal(producer?.queue, "hifiscout-product-audit-export");
  assert.equal(
    wranglerConfig.queues.producers.some(
      (item: { binding?: string }) => item.binding === "KNOWLEDGE_CATALOG_EXPORT_QUEUE",
    ),
    false,
  );
  assert.equal(
    wranglerConfig.queues.consumers.some(
      (item: { queue?: string }) => item.queue === "hifiscout-knowledge-catalog-export",
    ),
    false,
  );

  const consumer = wranglerConfig.queues.consumers.find(
    (item: { queue?: string }) => item.queue === "hifiscout-product-audit-export",
  );
  assert.equal(consumer?.max_batch_size, 1);
  assert.equal(consumer?.max_batch_timeout, 1);
  assert.equal(consumer?.max_retries, 10);
  assert.equal(consumer?.retry_delay, 30);
  assert.equal(consumer?.max_concurrency, 1);
  assert.equal(consumer?.dead_letter_queue, "hifiscout-product-audit-export-dlq");

  const deadLetterConsumer = wranglerConfig.queues.consumers.find(
    (item: { queue?: string }) => item.queue === "hifiscout-product-audit-export-dlq",
  );
  assert.equal(deadLetterConsumer?.max_batch_size, 1);
  assert.equal(deadLetterConsumer?.max_batch_timeout, 1);
  assert.equal(deadLetterConsumer?.max_retries, 3);
  assert.equal(deadLetterConsumer?.retry_delay, 30);
  assert.equal(deadLetterConsumer?.max_concurrency, 1);
  assert.match(schedulerSource, /recoverStaleProductAuditExportJobs/);
  assert.match(schedulerSource, /recoverStaleKnowledgeCatalogExportJobs/);
  assert.match(
    provisionProductionResources,
    /hifiscout-product-audit-exports\|product-audit-exports\/\|10/,
  );
  assert.match(
    provisionProductionResources,
    /hifiscout-knowledge-catalog-exports\|knowledge-catalog-exports\/\|10/,
  );
  assert.match(
    provisionProductionResources,
    /hifiscout-product-audit-export hifiscout-product-audit-export-dlq/,
  );
});
