import type { MetaResponse, ShopHealthReason, ShopHealthStatus } from "../../src/api/contracts.js";
import { expect, test } from "../fixtures/catalog-test.js";
import { product } from "./product-fixtures.js";

function projectionMetadata(reason: ShopHealthReason, status: ShopHealthStatus): MetaResponse {
  const lastSuccessAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const lastProjectionAt = new Date(Date.now() - 300 * 60_000).toISOString();
  return {
    status,
    shops: [
      {
        key: "shop-a",
        name: "Shop A",
        enabled: true,
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
          enabled: true,
          configured: true,
          intervalMinutes: 60,
          status,
          reason,
          ageMinutes: 10,
          projectionAgeMinutes: 300,
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

const cases = [
  { reason: "projection_delayed", status: "warning" },
  { reason: "projection_stale", status: "critical" },
] as const;

for (const { reason, status } of cases) {
  test(`catalog renders rather than rejecting ${reason} metadata`, async ({ page, catalogPage }) => {
    await page.route("**/api/meta", (route) =>
      route.fulfill({ json: projectionMetadata(reason, status) }),
    );
    await page.route("**/api/product-search?**", (route) =>
      route.fulfill({
        json: {
          items: [product()],
          hasMore: false,
          nextCursor: null,
          totalCount: 1,
          totalPages: 1,
        },
      }),
    );

    await catalogPage.goto();
    await expect(catalogPage.syncSummaryText).not.toContainText("取得中");
    await expect(catalogPage.productTitle("D-10X")).toBeVisible();
    await expect(catalogPage.count).toHaveText("1");
    await expect(catalogPage.manufacturerOptions.first()).toBeAttached();
    await catalogPage.openSyncDetails();
    await expect(catalogPage.syncStatusDetails).toContainText("Shop A");
    // A successful catalog load must not silently convert operational warnings to healthy.
    await expect(catalogPage.syncStatusDetails).not.toContainText("正常");
  });
}
