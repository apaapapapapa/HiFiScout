import test from "node:test";
import assert from "node:assert/strict";
import { buildSyncHealth, evaluateShopSyncHealth } from "../src/health.js";

test("sync health becomes warning and critical as success gets stale", () => {
  const now = new Date("2026-08-11T06:00:00.000Z");
  const base = { intervalMinutes: 30, enabled: true, now, warningFactor: 2, criticalFactor: 6 };

  assert.equal(
    evaluateShopSyncHealth({ ...base, state: { last_success_at: "2026-08-11T05:45:00.000Z" } })
      .status,
    "healthy",
  );
  assert.equal(
    evaluateShopSyncHealth({ ...base, state: { last_success_at: "2026-08-11T04:30:00.000Z" } })
      .status,
    "warning",
  );
  assert.equal(
    evaluateShopSyncHealth({ ...base, state: { last_success_at: "2026-08-11T02:00:00.000Z" } })
      .status,
    "critical",
  );
});

test("three consecutive failures are critical even after a recent success", () => {
  const health = evaluateShopSyncHealth({
    state: { last_success_at: "2026-08-11T05:55:00.000Z", consecutive_failures: 3 },
    intervalMinutes: 30,
    enabled: true,
    now: new Date("2026-08-11T06:00:00.000Z"),
  });
  assert.equal(health.status, "critical");
  assert.equal(health.reason, "repeated_failures");
});

test("enabled shop with missing transport configuration is immediately critical", () => {
  const health = evaluateShopSyncHealth({
    state: { last_success_at: "2026-08-11T05:59:00.000Z", consecutive_failures: 0 },
    intervalMinutes: 30,
    enabled: true,
    configured: false,
    now: new Date("2026-08-11T06:00:00.000Z"),
  });
  assert.equal(health.status, "critical");
  assert.equal(health.reason, "configuration_missing");
});

test("AudioUnion health exposes shared relay configuration and persisted item count", () => {
  const now = new Date("2026-08-11T06:00:00.000Z");
  const state = [
    {
      shop_key: "audiounion",
      last_success_at: "2026-08-11T05:59:00.000Z",
      last_attempt_at: "2026-08-11T05:58:00.000Z",
      last_item_count: 42,
      consecutive_failures: 0,
    },
  ];

  const missing = buildSyncHealth({ AUDIOUNION_ENABLED: "true" }, state, now).shops.find(
    (shop) => shop.shopKey === "audiounion",
  );
  assert.equal(missing.configured, false);
  assert.equal(missing.status, "critical");
  assert.equal(missing.reason, "configuration_missing");
  assert.equal(missing.lastItemCount, 42);

  const configured = buildSyncHealth(
    {
      AUDIOUNION_ENABLED: "true",
      CRAWL_RELAY_URL: "https://example.lambda-url.ap-northeast-1.on.aws/",
      CRAWL_RELAY_TOKEN: "x".repeat(64),
    },
    state,
    now,
  ).shops.find((shop) => shop.shopKey === "audiounion");
  assert.equal(configured.configured, true);
  assert.equal(configured.status, "healthy");
  assert.equal(configured.lastItemCount, 42);
});

test("disabled shops do not make overall health unhealthy", () => {
  const health = buildSyncHealth(
    { AUDIOUNION_ENABLED: "false" },
    [{ shop_key: "audiounion", consecutive_failures: 10 }],
    new Date("2026-08-11T06:00:00.000Z"),
  );
  const audioUnion = health.shops.find((shop) => shop.shopKey === "audiounion");
  assert.equal(audioUnion.status, "disabled");
  assert.notEqual(health.status, "critical");
});
