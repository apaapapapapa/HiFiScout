import type { Page, Response, Route } from "@playwright/test";
import { expect, test } from "../fixtures/catalog-test.js";
import { offer, product } from "./product-fixtures.js";
import type { JsonObject } from "./product-fixtures.js";

type HealthStatus = "healthy" | "warning" | "critical" | "disabled";

function syncState(key: string, lastSuccessAt: string) {
  return {
    shop_key: key,
    last_attempt_at: lastSuccessAt,
    last_success_at: lastSuccessAt,
    last_error_at: null,
    consecutive_failures: 0,
    backoff_until: null,
    last_error: null,
    last_item_count: 1,
    queued_at: null,
  };
}

function healthEntry(
  key: string,
  name: string,
  status: HealthStatus,
  lastSuccessAt: string | null,
  ageMinutes: number | null,
  enabled = true,
) {
  return {
    shopKey: key,
    name,
    enabled,
    configured: true,
    intervalMinutes: 60,
    status,
    ageMinutes,
    reason:
      status === "disabled"
        ? "disabled"
        : status === "warning"
          ? "sync_delayed"
          : status === "critical"
            ? "sync_stale"
            : "ok",
    lastSuccessAt,
    lastAttemptAt: lastSuccessAt,
    lastItemCount: 1,
    consecutiveFailures: 0,
    lastError: null,
  };
}

function shopMeta(
  key: string,
  name: string,
  lastSuccessAt: string,
  { status = "healthy", ageMinutes = 30 }: { status?: HealthStatus; ageMinutes?: number } = {},
) {
  return {
    key,
    name,
    enabled: true,
    intervalMinutes: 60,
    sync: syncState(key, lastSuccessAt),
    health: healthEntry(key, name, status, lastSuccessAt, ageMinutes),
  };
}

function mockMeta(overrides: JsonObject = {}) {
  return {
    status: "healthy",
    shops: [
      shopMeta("shop-a", "Shop A", "2026-08-11T10:00:00.000Z", { ageMinutes: 30 }),
      shopMeta("shop-b", "Shop B", "2026-08-11T10:05:00.000Z", { ageMinutes: 25 }),
    ],
    manufacturers: ["LUXMAN", "TAD"],
    categories: ["CD/SACDプレーヤー", "スピーカー"],
    categoryFacets: [
      {
        id: "digital-disc-player",
        name: "CD/SACDプレーヤー",
        parentId: null,
        order: 1,
        classifiable: true,
        filterable: true,
        group: "デジタル",
        activeProductCount: 1,
      },
      {
        id: "speaker",
        name: "スピーカー",
        parentId: null,
        order: 2,
        classifiable: false,
        filterable: true,
        group: null,
        activeProductCount: 1,
      },
    ],
    ...overrides,
  };
}

async function routeMeta(page: Page, meta: JsonObject = mockMeta()): Promise<void> {
  await page.route("**/api/meta", async (route: Route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(meta) });
  });
}

test("catalog page boots with live metadata and rendered results", async ({ page, catalogPage }) => {
  const metaResponsePromise = page.waitForResponse((response: Response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/meta" && response.request().method() === "GET";
  });

  await catalogPage.goto();

  const metaResponse = await metaResponsePromise;
  expect(metaResponse.ok()).toBeTruthy();

  const meta = await metaResponse.json();
  expect(Array.isArray(meta.shops)).toBeTruthy();
  expect(meta.shops.length).toBeGreaterThan(0);

  await expect(catalogPage.heading).toBeVisible();
  await expect(catalogPage.syncSummaryText).not.toContainText("取得中");
  await expect(catalogPage.count).toHaveText(/^\d+$/);
  await expect(catalogPage.countLabel).toHaveText("件を表示中");
  await expect(catalogPage.manufacturer).toHaveAttribute("type", "search");
  await expect(catalogPage.manufacturer).toHaveAttribute("list", "manufacturer-options");
  await expect(catalogPage.manufacturerOptions.first()).toBeAttached();
  await expect(catalogPage.products).toHaveClass(/view-list/);
  await expect(catalogPage.pageIndicator(1)).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#load-more")).toHaveCount(0);

  const visibleCount = Number((await catalogPage.count.textContent()) || 0);
  if (visibleCount > 0) {
    const titleControl = catalogPage.productTitleControl();
    await expect(titleControl).toBeVisible();
    const tagName = await titleControl.evaluate((element) => element.tagName);
    if (tagName === "BUTTON") {
      await expect(titleControl).toHaveAttribute("data-offers", /.+/);
    } else {
      expect(tagName).toBe("A");
      await expect(titleControl).toHaveAttribute("href", /^https?:\/\//);
      await expect(titleControl).toHaveAttribute("target", "_blank");
    }
  }
});

test("changing a shop filter exposes a removable filter chip", async ({ page, catalogPage }) => {
  await catalogPage.goto();
  await expect(catalogPage.syncSummaryText).not.toContainText("取得中");
  await expect(catalogPage.count).toHaveText(/^\d+$/);

  const firstShopOption = catalogPage.firstShopOption();
  const firstShopValue = await firstShopOption.getAttribute("value");
  if (!firstShopValue) {
    throw new Error("Expected at least one selectable shop option");
  }
  const firstShopLabel = (await firstShopOption.textContent())?.trim() || firstShopValue;
  const firstShopFilterLabel = firstShopLabel.replace(/\s+\(\d+\)$/u, "");

  await catalogPage.selectShop(firstShopValue);

  await expect(catalogPage.shop).toHaveValue(firstShopValue);
  await expect(catalogPage.activeFilters).toContainText(firstShopFilterLabel);
  await expect(page).toHaveURL(new RegExp(`shop=${encodeURIComponent(firstShopValue)}`));
  await expect(catalogPage.count).toHaveText(/^\d+$/);

  await catalogPage.clearFilterButton("shop").click();
  await expect(catalogPage.shop).toHaveValue("");
  await expect(catalogPage.activeFilters).not.toContainText(firstShopFilterLabel);
  await expect(catalogPage.count).toHaveText(/^\d+$/);
});

test("mobile uses a bottom-sheet filter panel while keeping search visible", async ({
  catalogPage,
}) => {
  await catalogPage.useMobileViewport();
  await catalogPage.goto();
  await expect(catalogPage.syncSummaryText).not.toContainText("取得中");
  await expect(catalogPage.count).toHaveText(/^\d+$/);

  await expect(catalogPage.searchInput).toBeVisible();
  await expect(catalogPage.filterToggle).toBeVisible();
  await expect(catalogPage.filterPanel).not.toHaveClass(/open/);

  await catalogPage.openFilters();
  await expect(catalogPage.filterPanel).toHaveClass(/open/);
  await expect(catalogPage.filterToggle).toHaveAttribute("aria-expanded", "true");

  await catalogPage.applyFilters();
  await expect(catalogPage.filterPanel).not.toHaveClass(/open/);
  await expect(catalogPage.filterToggle).toHaveAttribute("aria-expanded", "false");
});

test("favorites are stored as product snapshots and rendered without a favorites API", async ({
  page,
  catalogPage,
}) => {
  let productRequests = 0;
  const first = product();
  const second = product({
    key: "c-2",
    catalog_product_id: 2,
    manufacturer: "TAD",
    manufacturer_id: "tad",
    model: "ME1TX",
    category: "スピーカー",
    primary_category_id: "speaker",
    lowest_price_yen: 980000,
    highest_price_yen: 980000,
    has_price_drop: false,
    representative_offer: offer({
      listing_product_id: 2,
      title: "TAD ME1TX",
      price_yen: 980000,
      previous_price_yen: null,
      source_url: "https://example.com/products/2",
    }),
  });

  await routeMeta(page);

  await page.route("**/api/product-search?**", async (route: Route) => {
    productRequests += 1;
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        cursor
          ? { items: [second], hasMore: false, nextCursor: null, totalCount: 2, totalPages: 2 }
          : { items: [first], hasMore: true, nextCursor: "cursor-2", totalCount: 2, totalPages: 2 },
      ),
    });
  });

  await catalogPage.goto();
  await expect(catalogPage.productTitle("D-10X")).toBeVisible();
  await catalogPage.addFavorite("c-1");

  const stored: unknown = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hifiscout:favorites") || "[]"),
  );
  expect(stored).toHaveLength(1);
  expect(stored).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "c-1", manufacturer: "LUXMAN", model: "D-10X" }),
    ]),
  );

  await catalogPage.goToPage(2);
  await expect(catalogPage.productTitle("ME1TX")).toBeVisible();
  await expect(catalogPage.productTitle("D-10X")).toHaveCount(0);
  const requestsBeforeFavorites = productRequests;

  await catalogPage.showFavoritesOnly();
  await expect(catalogPage.productTitle("D-10X")).toBeVisible();
  await expect(catalogPage.productTitle("ME1TX")).toHaveCount(0);
  await expect(catalogPage.pagination).toBeEmpty();
  expect(productRequests).toBe(requestsBeforeFavorites);
});

test("sync status summarizes delayed shops and exposes per-shop details", async ({
  page,
  catalogPage,
}) => {
  const healthyAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const delayedAt = new Date(Date.now() - 150 * 60_000).toISOString();
  await routeMeta(
    page,
    mockMeta({
      status: "warning",
      shops: [
        shopMeta("shop-a", "Shop A", healthyAt, { status: "healthy", ageMinutes: 10 }),
        shopMeta("shop-b", "Shop B", delayedAt, { status: "warning", ageMinutes: 150 }),
      ],
    }),
  );
  await page.route("**/api/product-search?**", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [product()], hasMore: false, nextCursor: null }),
    }),
  );

  await catalogPage.goto();
  await expect(catalogPage.syncSummaryText).toHaveText("⚠ 1店舗で更新が遅れています");
  await catalogPage.openSyncDetails();
  await expect(catalogPage.syncStatusDetails).toContainText("Shop A");
  await expect(catalogPage.syncStatusDetails).toContainText("正常");
  await expect(catalogPage.syncStatusDetails).toContainText("Shop B");
  await expect(catalogPage.syncStatusDetails).toContainText("遅延");
  await expect(catalogPage.syncStatusDetails).toContainText("分前");
});

test("URL restores search state and recent/price-drop filters reach the API", async ({
  page,
  catalogPage,
}) => {
  await routeMeta(page);
  const requests: URL[] = [];
  await page.route("**/api/product-search?**", async (route: Route) => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [product()],
        hasMore: true,
        nextCursor: "cursor-2",
        totalCount: 2,
        totalPages: 2,
      }),
    });
  });

  await catalogPage.goto(
    "/?manufacturer=LUXMAN&sort=priceAsc&inStock=false&newOnly=true&priceDropped=true",
  );

  await expect(catalogPage.manufacturer).toHaveValue("LUXMAN");
  await expect(catalogPage.sort).toHaveValue("priceAsc");
  await expect(catalogPage.inStock).not.toBeChecked();
  await expect(catalogPage.recentOnly).toBeChecked();
  await expect(catalogPage.priceDropped).toBeChecked();
  await expect(catalogPage.activeFilters).toContainText("48時間以内の新着");
  await expect(catalogPage.activeFilters).toContainText("値下げ商品");
  await expect(catalogPage.moreAvailable).toBeVisible();

  expect(requests.length).toBeGreaterThan(0);
  const firstRequest = requests[0];
  if (!firstRequest) {
    throw new Error("Expected at least one product request");
  }
  const params = firstRequest.searchParams;
  expect(params.get("manufacturer")).toBe("LUXMAN");
  expect(params.get("sort")).toBe("priceAsc");
  expect(params.has("inStock")).toBeFalsy();
  expect(params.get("newOnly")).toBe("true");
  expect(params.get("priceDropped")).toBe("true");
});

test("browser back restores previous filter state", async ({ page, catalogPage }) => {
  await routeMeta(page);
  await page.route("**/api/product-search?**", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [product()], hasMore: false, nextCursor: null }),
    }),
  );

  await catalogPage.goto();
  await catalogPage.enableRecentOnly();
  await expect(page).toHaveURL(/newOnly=true/);
  await catalogPage.enablePriceDropped();
  await expect(page).toHaveURL(/priceDropped=true/);

  await page.goBack();
  await expect(catalogPage.recentOnly).toBeChecked();
  await expect(catalogPage.priceDropped).not.toBeChecked();
});
