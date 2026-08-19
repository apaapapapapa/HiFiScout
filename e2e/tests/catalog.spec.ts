import { expect, test, type Page, type Response, type Route } from "@playwright/test";
import { isProductSearchRequest as isProductsRequest, offer, product } from "./product-fixtures.js";
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

test("catalog page boots with live metadata and product API", async ({ page }) => {
  const metaResponsePromise = page.waitForResponse((response: Response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/meta" && response.request().method() === "GET";
  });
  const productsResponsePromise = page.waitForResponse(isProductsRequest);

  await page.goto("/");

  const [metaResponse, productsResponse] = await Promise.all([
    metaResponsePromise,
    productsResponsePromise,
  ]);

  expect(metaResponse.ok()).toBeTruthy();
  expect(productsResponse.ok()).toBeTruthy();

  const meta = await metaResponse.json();
  const products = await productsResponse.json();
  expect(Array.isArray(meta.shops)).toBeTruthy();
  expect(meta.shops.length).toBeGreaterThan(0);
  expect(Array.isArray(products.items)).toBeTruthy();

  await expect(page.getByRole("heading", { name: "HiFiScout" })).toBeVisible();
  await expect(page.locator("#sync-summary-text")).not.toContainText("取得中");
  await expect(page.locator("#count")).toHaveText(/^\d+$/);
  await expect(page.locator("#count-label")).toHaveText("件を表示中");
  await expect(page.locator("#manufacturer")).toHaveAttribute("type", "search");
  await expect(page.locator("#manufacturer")).toHaveAttribute("list", "manufacturer-options");
  await expect(page.locator("#manufacturer-options option").first()).toBeAttached();
  await expect(page.locator("#products")).toHaveClass(/view-list/);
  await expect(page.locator('#pagination [data-page="1"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#load-more")).toHaveCount(0);

  if (products.items.length) {
    const titleControl = page.locator(".product-title-link").first();
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

test("changing a shop filter refreshes the API and exposes a removable filter chip", async ({
  page,
}) => {
  const initialProductsResponse = page.waitForResponse(isProductsRequest);
  await page.goto("/");
  await initialProductsResponse;

  const firstShopOption = page.locator('#shop option:not([value=""])').first();
  const firstShopValue = await firstShopOption.getAttribute("value");
  if (!firstShopValue) {
    throw new Error("Expected at least one selectable shop option");
  }
  const firstShopLabel = (await firstShopOption.textContent())?.trim() || firstShopValue;

  const filteredResponsePromise = page.waitForResponse((response: Response) => {
    if (!isProductsRequest(response)) return false;
    return new URL(response.url()).searchParams.get("shop") === firstShopValue;
  });

  await page.locator("#shop").selectOption(firstShopValue);
  const filteredResponse = await filteredResponsePromise;

  expect(filteredResponse.ok()).toBeTruthy();
  await expect(page.locator("#shop")).toHaveValue(firstShopValue);
  await expect(page.locator("#active-filters")).toContainText(firstShopLabel);
  await expect(page).toHaveURL(new RegExp(`shop=${encodeURIComponent(firstShopValue)}`));

  await page.locator('[data-clear-filter="shop"]').click();
  await expect(page.locator("#shop")).toHaveValue("");
  await expect(page.locator("#active-filters")).not.toContainText(firstShopLabel);
  await expect(page.locator("#count")).toHaveText(/^\d+$/);
});

test("mobile uses a bottom-sheet filter panel while keeping search visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const initialProductsResponse = page.waitForResponse(isProductsRequest);
  await page.goto("/");
  await initialProductsResponse;

  await expect(page.locator("#q")).toBeVisible();
  await expect(page.locator("#filter-toggle")).toBeVisible();
  await expect(page.locator("#filter-panel")).not.toHaveClass(/open/);

  await page.locator("#filter-toggle").click();
  await expect(page.locator("#filter-panel")).toHaveClass(/open/);
  await expect(page.locator("#filter-toggle")).toHaveAttribute("aria-expanded", "true");

  await page.locator("#apply-filters").click();
  await expect(page.locator("#filter-panel")).not.toHaveClass(/open/);
  await expect(page.locator("#filter-toggle")).toHaveAttribute("aria-expanded", "false");
});

test("favorites are stored as product snapshots and rendered without a favorites API", async ({
  page,
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

  await page.goto("/");
  await expect(page.getByRole("link", { name: "D-10X" })).toBeVisible();
  await page.locator('[data-fav="c-1"]').click();

  const stored: unknown = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hifiscout:favorites") || "[]"),
  );
  expect(stored).toHaveLength(1);
  expect(stored).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "c-1", manufacturer: "LUXMAN", model: "D-10X" }),
    ]),
  );

  await page.locator("#pagination").getByRole("button", { name: "2" }).click();
  await expect(page.getByRole("link", { name: "ME1TX" })).toBeVisible();
  await expect(page.getByRole("link", { name: "D-10X" })).toHaveCount(0);
  const requestsBeforeFavorites = productRequests;

  await page.locator("#favoritesOnly").check();
  await expect(page.getByRole("link", { name: "D-10X" })).toBeVisible();
  await expect(page.getByRole("link", { name: "ME1TX" })).toHaveCount(0);
  await expect(page.locator("#pagination")).toBeEmpty();
  expect(productRequests).toBe(requestsBeforeFavorites);
});

test("sync status summarizes delayed shops and exposes per-shop details", async ({ page }) => {
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

  await page.goto("/");
  await expect(page.locator("#sync-summary-text")).toHaveText("⚠ 1店舗で更新が遅れています");
  await page.locator("#sync-status summary").click();
  await expect(page.locator("#sync-status-details")).toContainText("Shop A");
  await expect(page.locator("#sync-status-details")).toContainText("正常");
  await expect(page.locator("#sync-status-details")).toContainText("Shop B");
  await expect(page.locator("#sync-status-details")).toContainText("遅延");
  await expect(page.locator("#sync-status-details")).toContainText("分前");
});

test("URL restores search state and recent/price-drop filters reach the API", async ({ page }) => {
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

  await page.goto(
    "/?manufacturer=LUXMAN&sort=priceAsc&inStock=false&newOnly=true&priceDropped=true",
  );

  await expect(page.locator("#manufacturer")).toHaveValue("LUXMAN");
  await expect(page.locator("#sort")).toHaveValue("priceAsc");
  await expect(page.locator("#inStock")).not.toBeChecked();
  await expect(page.locator("#recentOnly")).toBeChecked();
  await expect(page.locator("#priceDropped")).toBeChecked();
  await expect(page.locator("#active-filters")).toContainText("48時間以内の新着");
  await expect(page.locator("#active-filters")).toContainText("値下げ商品");
  await expect(page.locator("#more-available")).toBeVisible();

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

test("browser back restores previous filter state", async ({ page }) => {
  await routeMeta(page);
  await page.route("**/api/product-search?**", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [product()], hasMore: false, nextCursor: null }),
    }),
  );

  await page.goto("/");
  await page.locator("#recentOnly").check();
  await expect(page).toHaveURL(/newOnly=true/);
  await page.locator("#priceDropped").check();
  await expect(page).toHaveURL(/priceDropped=true/);

  await page.goBack();
  await expect(page.locator("#recentOnly")).toBeChecked();
  await expect(page.locator("#priceDropped")).not.toBeChecked();
});
