import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { isMetaResponse } from "../frontend/api-client.js";
import type { MetaResponse, ShopHealthReason, ShopHealthStatus } from "../src/api/contracts.js";

// Adding a server reason must require a corresponding browser-validation case.
const reasonStatuses: Record<ShopHealthReason, ShopHealthStatus> = {
  disabled: "disabled",
  configuration_missing: "critical",
  never_succeeded_repeated_failures: "critical",
  never_succeeded: "warning",
  repeated_failures: "critical",
  sync_stale: "critical",
  recent_failure: "warning",
  sync_delayed: "warning",
  projection_stale: "critical",
  projection_delayed: "warning",
  ok: "healthy",
};

function metadata(reason: ShopHealthReason): MetaResponse {
  const status = reasonStatuses[reason];
  const lastSuccessAt = "2026-09-05T00:00:00.000Z";
  const lastProjectionAt = "2026-09-04T00:00:00.000Z";
  return {
    status,
    shops: [
      {
        key: "shop-a",
        name: "Shop A",
        enabled: reason !== "disabled",
        intervalMinutes: 60,
        activeProductCount: 1,
        sync: {
          shop_key: "shop-a",
          last_attempt_at: lastSuccessAt,
          last_success_at: lastSuccessAt,
          last_projection_at: lastProjectionAt,
          last_error_at: null,
          consecutive_failures: 0,
          backoff_until: null,
          last_error: null,
          last_item_count: 1,
          queued_at: null,
        },
        health: {
          shopKey: "shop-a",
          name: "Shop A",
          enabled: reason !== "disabled",
          configured: true,
          intervalMinutes: 60,
          status,
          reason,
          ageMinutes: 10,
          projectionAgeMinutes: 1450,
          lastSuccessAt,
          lastProjectionAt,
          lastAttemptAt: lastSuccessAt,
          lastItemCount: 1,
          consecutiveFailures: 0,
          lastError: null,
        },
      },
    ],
    manufacturers: ["LUXMAN"],
    categories: ["CD/SACDプレーヤー"],
    categoryFacets: [],
  };
}

for (const reason of Object.keys(reasonStatuses) as ShopHealthReason[]) {
  test(`browser accepts the server's ${reason} shop-health reason`, () => {
    assert.equal(isMetaResponse(metadata(reason)), true);
  });
}

test("a shop with delayed projections does not invalidate otherwise healthy catalog metadata", () => {
  const meta = metadata("ok");
  const delayedShop = metadata("projection_delayed").shops[0];
  assert.ok(delayedShop);
  meta.shops.push({ ...delayedShop, key: "shop-b", name: "Shop B" });
  meta.status = "warning";
  assert.equal(isMetaResponse(meta), true);
});

test("metadata validation still rejects unknown, inherited, and non-string health reasons", () => {
  const meta = metadata("ok");
  const shop = meta.shops[0];
  assert.ok(shop);
  assert.ok(shop.health);
  for (const reason of ["future_reason", "constructor", "toString", "__proto__", "", null, undefined, 0, {}, []]) {
    const malformed = {
      ...meta,
      shops: [{ ...shop, health: { ...shop.health, reason } }],
    };
    assert.equal(isMetaResponse(malformed), false, `must reject ${String(reason)}`);
  }
});

test("accepting projection reasons does not weaken validation of the surrounding payload", () => {
  const meta = metadata("projection_stale");
  const shop = meta.shops[0];
  assert.ok(shop);
  assert.ok(shop.health);
  for (const fields of [{ ageMinutes: "10" }, { consecutiveFailures: -1 }, { status: "unknown" }]) {
    assert.equal(
      isMetaResponse({ ...meta, shops: [{ ...shop, health: { ...shop.health, ...fields } }] }),
      false,
    );
  }
});
