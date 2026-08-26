import { test } from "vite-plus/test";
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
  assert.ok(missing);
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
  assert.ok(configured);
  assert.equal(configured.configured, true);
  assert.equal(configured.status, "healthy");
  assert.equal(configured.lastItemCount, 42);
});

test("public sync health never exposes persisted crawler error text", () => {
  const secretError =
    "fetch failed: https://internal.example.test/path?token=super-secret upstream=10.0.0.7";
  const health = buildSyncHealth(
    { HIFIDO_ENABLED: "true" },
    [
      {
        shop_key: "hifido",
        last_success_at: "2026-08-11T05:59:00.000Z",
        last_attempt_at: "2026-08-11T06:00:00.000Z",
        consecutive_failures: 1,
        last_error: secretError,
      },
    ],
    new Date("2026-08-11T06:00:00.000Z"),
  );
  const hifido = health.shops.find((shop) => shop.shopKey === "hifido");

  assert.ok(hifido);
  assert.equal(hifido.lastError, null);
  assert.doesNotMatch(JSON.stringify(health), /super-secret|internal\.example\.test|10\.0\.0\.7/u);
});

test("disabled shops do not make overall health unhealthy", () => {
  const health = buildSyncHealth(
    { AUDIOUNION_ENABLED: "false" },
    [{ shop_key: "audiounion", consecutive_failures: 10 }],
    new Date("2026-08-11T06:00:00.000Z"),
  );
  const audioUnion = health.shops.find((shop) => shop.shopKey === "audiounion");
  assert.ok(audioUnion);
  assert.equal(audioUnion.status, "disabled");
  assert.notEqual(health.status, "critical");
});

test("fresh listings nobody can search for are not a healthy shop", () => {
  const now = new Date("2026-08-26T06:00:00.000Z");
  const base = { intervalMinutes: 30, enabled: true, now, warningFactor: 2, criticalFactor: 6 };

  // The inventory watermark says this shop was crawled five minutes ago. The projection watermark
  // says its derived work has not completed since yesterday, so search is serving stale grouping.
  const health = evaluateShopSyncHealth({
    ...base,
    state: {
      last_success_at: "2026-08-26T05:55:00.000Z",
      last_projection_at: "2026-08-25T18:00:00.000Z",
    },
  });

  assert.equal(health.status, "critical");
  assert.equal(health.reason, "projection_stale");
  assert.equal(health.ageMinutes, 5, "the inventory is still reported as fresh");
  assert.equal(health.projectionAgeMinutes, 720);
});

test("a projection still catching up after a deferred crawl is not a concern", () => {
  const now = new Date("2026-08-26T06:00:00.000Z");
  // Handing the remaining chunks to the continuation sweep is an ordinary outcome, so a short lag
  // must not degrade the shop; only a gap that keeps growing means the sweep stopped finishing.
  const health = evaluateShopSyncHealth({
    intervalMinutes: 30,
    enabled: true,
    now,
    warningFactor: 2,
    criticalFactor: 6,
    state: {
      last_success_at: "2026-08-26T05:55:00.000Z",
      last_projection_at: "2026-08-26T05:40:00.000Z",
    },
  });

  assert.equal(health.status, "healthy");
  assert.equal(health.reason, "ok");
  assert.equal(health.projectionAgeMinutes, 20);
});

test("a projection level with the inventory reports no lag at all", () => {
  const health = evaluateShopSyncHealth({
    intervalMinutes: 30,
    enabled: true,
    now: new Date("2026-08-26T06:00:00.000Z"),
    state: {
      last_success_at: "2026-08-26T05:55:00.000Z",
      last_projection_at: "2026-08-26T05:55:00.000Z",
    },
  });

  assert.equal(health.status, "healthy");
  assert.equal(health.projectionAgeMinutes, null);
});

test("a worse inventory problem keeps its own reason", () => {
  const health = evaluateShopSyncHealth({
    intervalMinutes: 30,
    enabled: true,
    now: new Date("2026-08-26T06:00:00.000Z"),
    state: {
      last_success_at: "2026-08-26T05:55:00.000Z",
      last_projection_at: "2026-08-26T04:00:00.000Z",
      consecutive_failures: 3,
    },
  });

  assert.equal(health.status, "critical");
  assert.equal(health.reason, "repeated_failures");
  assert.equal(health.projectionAgeMinutes, 120, "the lag is still reported alongside it");
});
