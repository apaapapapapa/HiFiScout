import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { requiredLifecycleRules, requiredQueues } from "../scripts/lib/production-resources.js";
import { SHOP_DEFINITIONS, getShopEnabled, getShopRequestDelayMs } from "../src/config.js";
import { isShopDue, isSuspiciousItemDrop } from "../src/crawler/run.js";
import {
  roundRobinShopForScheduledTime,
  sharedSweepExclusions,
  shopForCronAtScheduledTime,
  shopsForCron,
  shopsInRoundRobin,
  shopsWithDedicatedCron,
} from "../src/crawler/schedule.js";
import {
  CRAWL_ROTATION_CRON,
  GENERAL_CRON,
  isDailyMaintenanceSlot,
  isKnowledgeCatalogMonthlySlot,
} from "../src/scheduled.js";

const wranglerConfig = JSON.parse(
  fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const schedulerSource = fs.readFileSync(new URL("../src/scheduled.ts", import.meta.url), "utf8");

const SHARED_HOURLY_CRON = "1,31 * * * *";

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

test("dedicated crawl schedules match the requested cadence", () => {
  assert.equal(SHOP_DEFINITIONS.audiounion.scheduleCron, SHARED_HOURLY_CRON);
  assert.equal(SHOP_DEFINITIONS.hifido.scheduleCron, SHARED_HOURLY_CRON);
  // Cloudflare Cron is UTC, so 12:30 UTC is 21:30 JST.
  assert.equal(SHOP_DEFINITIONS["fujiya-avic"].scheduleCron, "30 12 * * *");

  assert.equal(wranglerConfig.vars.AUDIOUNION_INTERVAL_MINUTES, "60");
  assert.equal(wranglerConfig.vars.HIFIDO_INTERVAL_MINUTES, "60");
  assert.equal(wranglerConfig.vars.FUJIYA_AVIC_INTERVAL_MINUTES, "1440");
});

test("AudioUnion and HiFiDo share one cron and alternate every thirty minutes from :01", () => {
  assert.deepEqual(
    shopsForCron(SHARED_HOURLY_CRON).map((plugin) => plugin.key),
    ["audiounion", "hifido"],
  );
  assert.equal(
    shopForCronAtScheduledTime(SHARED_HOURLY_CRON, new Date("2026-08-24T00:01:00.000Z"))?.key,
    "audiounion",
  );
  assert.equal(
    shopForCronAtScheduledTime(SHARED_HOURLY_CRON, new Date("2026-08-24T00:31:00.000Z"))?.key,
    "hifido",
  );
  assert.equal(
    shopForCronAtScheduledTime(SHARED_HOURLY_CRON, new Date("2026-08-24T01:01:00.000Z"))?.key,
    "audiounion",
  );
  assert.equal(
    shopForCronAtScheduledTime(SHARED_HOURLY_CRON, new Date("2026-08-24T01:31:00.000Z"))?.key,
    "hifido",
  );
  assert.equal(shopForCronAtScheduledTime(SHARED_HOURLY_CRON, new Date("invalid")), null);
});

test("dedicated shop crons are declared in wrangler and may be shared", () => {
  const crons: string[] = wranglerConfig.triggers?.crons || [];
  const dedicated = shopsWithDedicatedCron();
  assert.equal(dedicated.length, 3);

  for (const plugin of dedicated) {
    const cron = plugin.definition.scheduleCron;
    assert.ok(cron);
    assert.ok(crons.includes(cron), `${plugin.key} cron ${cron} is missing from wrangler.jsonc`);
    assert.ok(shopsForCron(cron).includes(plugin));
  }

  assert.equal(
    shopForCronAtScheduledTime("30 12 * * *", new Date("2026-08-24T12:30:00.000Z"))?.key,
    "fujiya-avic",
  );
});

test("all non-dedicated shops share one ten-minute round robin", () => {
  const roundRobin = shopsInRoundRobin();
  const expectedIntervalMinutes = roundRobin.length * 10;
  assert.equal(roundRobin.length, 14);
  assert.equal(CRAWL_ROTATION_CRON, "6-56/10 * * * *");
  assert.ok(wranglerConfig.triggers.crons.includes(CRAWL_ROTATION_CRON));

  for (const plugin of roundRobin) {
    assert.equal(plugin.definition.scheduleCron, undefined);
    assert.equal(plugin.definition.defaultIntervalMinutes, expectedIntervalMinutes);
    assert.equal(
      wranglerConfig.vars[`${plugin.definition.envPrefix}_INTERVAL_MINUTES`],
      String(expectedIntervalMinutes),
    );
  }
});

test("round robin advances exactly one shop every ten minutes and wraps", () => {
  const roundRobin = shopsInRoundRobin();
  const firstTime = new Date("2026-08-23T00:06:00.000Z");
  const first = roundRobinShopForScheduledTime(firstTime);
  assert.ok(first);

  const firstIndex = roundRobin.indexOf(first);
  assert.notEqual(firstIndex, -1);

  const next = roundRobinShopForScheduledTime(new Date(firstTime.getTime() + 10 * 60_000));
  assert.equal(next, roundRobin[(firstIndex + 1) % roundRobin.length]);

  const wrapped = roundRobinShopForScheduledTime(
    new Date(firstTime.getTime() + roundRobin.length * 10 * 60_000),
  );
  assert.equal(wrapped, first);
  assert.equal(roundRobinShopForScheduledTime(new Date("invalid")), null);
});

test("dedicated shops are excluded from the shared rotation", () => {
  assert.deepEqual(
    [...sharedSweepExclusions()].sort(),
    shopsWithDedicatedCron()
      .map((plugin) => plugin.key)
      .sort(),
  );
  assert.deepEqual(shopsForCron(GENERAL_CRON), []);
  assert.deepEqual(shopsForCron(CRAWL_ROTATION_CRON), []);
  assert.deepEqual(shopsForCron(""), []);
});

test("scheduled crawl dispatch uses policy and the scheduled event timestamp", () => {
  assert.match(schedulerSource, /shopForCronAtScheduledTime\(cron, scheduledAt\)/);
  assert.match(schedulerSource, /roundRobinShopForScheduledTime\(scheduledAt\)/);
  assert.match(schedulerSource, /new Date\(controller\.scheduledTime\)/);
  assert.doesNotMatch(schedulerSource, /dispatchDueCrawls/);
});

test("production cron configuration leaves one spare Cloudflare Free trigger", () => {
  const crons: string[] = wranglerConfig.triggers?.crons || [];
  const dedicatedCrons = [
    ...new Set(
      shopsWithDedicatedCron()
        .map((plugin) => plugin.definition.scheduleCron)
        .filter(Boolean),
    ),
  ];
  const handled = [GENERAL_CRON, CRAWL_ROTATION_CRON, ...dedicatedCrons];

  assert.equal(crons.length, 4);
  assert.ok(crons.length <= 5);
  assert.deepEqual([...crons].sort(), [...handled].sort());
  assert.ok(crons.includes(SHARED_HOURLY_CRON));
  assert.ok(!crons.includes("1 * * * *"));
  assert.ok(!crons.includes("31 * * * *"));
  assert.ok(!crons.includes("17 18 * * *"));
  assert.ok(!crons.includes("23 3 1 * *"));
});

test("daily and monthly maintenance piggyback on the five-minute general cron", () => {
  assert.equal(isDailyMaintenanceSlot(new Date("2026-08-24T18:20:00.000Z")), true);
  assert.equal(isDailyMaintenanceSlot(new Date("2026-08-24T18:15:00.000Z")), false);
  assert.equal(isDailyMaintenanceSlot(new Date("invalid")), false);

  assert.equal(isKnowledgeCatalogMonthlySlot(new Date("2026-09-01T03:25:00.000Z")), true);
  assert.equal(isKnowledgeCatalogMonthlySlot(new Date("2026-09-02T03:25:00.000Z")), false);
  assert.equal(isKnowledgeCatalogMonthlySlot(new Date("2026-09-01T03:20:00.000Z")), false);
  assert.equal(isKnowledgeCatalogMonthlySlot(new Date("invalid")), false);

  assert.match(schedulerSource, /isDailyMaintenanceSlot\(at\)/);
  assert.match(schedulerSource, /isKnowledgeCatalogMonthlySlot\(at\)/);
  assert.match(schedulerSource, /name: "daily_retention"/);
  assert.match(schedulerSource, /runRetentionCleanup\(env, \{ now \}\)/);
  assert.match(schedulerSource, /dispatchKnowledgeCatalogDailyVerification\(env, \{ now \}\)/);
  assert.match(schedulerSource, /dispatchKnowledgeCatalogMonthlyRecheck\(env, \{ now \}\)/);
});

test("large item-count drops are rejected only after a meaningful baseline", () => {
  assert.equal(isSuspiciousItemDrop(49, 100, { minRatio: 0.5, minBaseline: 20 }), true);
  assert.equal(isSuspiciousItemDrop(50, 100, { minRatio: 0.5, minBaseline: 20 }), false);
  assert.equal(isSuspiciousItemDrop(1, 10, { minRatio: 0.5, minBaseline: 20 }), false);
});

test("Knowledge Catalog verification is dispatched to its dedicated queue", () => {
  assert.equal(wranglerConfig.vars.KNOWLEDGE_CATALOG_DAILY_VERIFY_MAX_CANDIDATES, "200");
  assert.equal(wranglerConfig.vars.KNOWLEDGE_CATALOG_REVIEW_INTERVAL_DAYS, "30");
  assert.equal(wranglerConfig.vars.KNOWLEDGE_CATALOG_QUEUE_WAKE_MAX_JOBS, "8");
  assert.equal(wranglerConfig.vars.KNOWLEDGE_CATALOG_QUEUE_WAKE_WALL_BUDGET_MS, "25000");

  const producer = wranglerConfig.queues.producers.find(
    (item: { binding?: string }) => item.binding === "KNOWLEDGE_CATALOG_QUEUE",
  );
  assert.equal(producer?.queue, "hifiscout-knowledge-verification");
  const consumer = wranglerConfig.queues.consumers.find(
    (item: { queue?: string }) => item.queue === "hifiscout-knowledge-verification",
  );
  assert.equal(consumer?.max_batch_size, 1);
  assert.equal(consumer?.max_retries, 8);
  assert.equal(consumer?.max_concurrency, 1);
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
  for (const [id, prefix] of [
    ["hifiscout-product-audit-exports", "product-audit-exports/"],
    ["hifiscout-knowledge-catalog-exports", "knowledge-catalog-exports/"],
  ]) {
    assert.deepEqual(
      requiredLifecycleRules.find((rule) => rule.id === id),
      {
        id,
        enabled: true,
        conditions: { prefix },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 10 * 86400 } },
      },
    );
  }
  assert.ok(requiredQueues.includes("hifiscout-product-audit-export"));
  assert.ok(requiredQueues.includes("hifiscout-product-audit-export-dlq"));
});
