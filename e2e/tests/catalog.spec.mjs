import { expect, test } from "@playwright/test";

function isProductsRequest(response) {
  const url = new URL(response.url());
  return url.pathname === "/api/products" && response.request().method() === "GET";
}

function product(overrides = {}) {
  return {
    id: 1,
    shop_key: "shop-a",
    manufacturer: "LUXMAN",
    manufacturer_id: "luxman",
    raw_manufacturer: "LUXMAN",
    model: "D-10X",
    title: "LUXMAN D-10X",
    category: "CD/SACDプレーヤー",
    raw_category: "CD/SACDプレーヤー",
    primary_category_id: "digital-disc-player",
    category_ids: ["digital-disc-player"],
    condition_text: "中古",
    price_yen: 698000,
    previous_price_yen: 748000,
    stock_status: "in_stock",
    source_url: "https://example.com/products/1",
    first_seen_at: "2026-08-11T08:00:00.000Z",
    last_seen_at: "2026-08-11T10:00:00.000Z",
    last_changed_at: "2026-08-11T10:00:00.000Z",
    last_activity_at: "2026-08-11T10:00:00.000Z",
    search_aliases: "SACD CD player",
    ...overrides,
  };
}

function mockMeta(overrides = {}) {
  return {
    status: "healthy",
    shops: [
      {
        key: "shop-a",
        name: "Shop A",
        intervalMinutes: 60,
        sync: { last_success_at: "2026-08-11T10:00:00.000Z" },
        health: { status: "healthy", lastSuccessAt: "2026-08-11T10:00:00.000Z", ageMinutes: 30 },
      },
      {
        key: "shop-b",
        name: "Shop B",
        intervalMinutes: 60,
        sync: { last_success_at: "2026-08-11T10:05:00.000Z" },
        health: { status: "healthy", lastSuccessAt: "2026-08-11T10:05:00.000Z", ageMinutes: 25 },
      },
    ],
    manufacturers: ["LUXMAN", "TAD"],
    categories: ["CD/SACDプレーヤー", "スピーカー"],
    categoryFacets: [
      { id: "digital-disc-player", name: "CD/SACDプレーヤー", group: "デジタル" },
      { id: "speaker", name: "スピーカー", group: null },
    ],
    ...overrides,
  };
}

async function routeMeta(page, meta = mockMeta()) {
  await page.route("**/api/meta", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(meta) });
  });
}

test("catalog page boots with live metadata and product API", async ({ page }) => {
  const metaResponsePromise = page.waitForResponse((response) => {
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
    const titleLink = page.locator(".product-title-link").first();
    await expect(titleLink).toBeVisible();
    await expect(titleLink).toHaveAttribute("target", "_blank");
  }
});

test("changing a shop filter refreshes the API and exposes a removable filter chip", async ({
  page,
}) => {
  const initialProductsResponse = page.waitForResponse(isProductsRequest);
  await page.goto("/");
  await initialProductsResponse;

  const firstShop = await page.locator("#shop option").evaluateAll((options) => {
    const option = options.find((candidate) => candidate.value);
    return option
      ? { value: option.value, label: option.textContent?.trim() || option.value }
      : null;
  });
  expect(firstShop).not.toBeNull();

  const filteredResponsePromise = page.waitForResponse((response) => {
    if (!isProductsRequest(response)) return false;
    return new URL(response.url()).searchParams.get("shop") === firstShop.value;
  });

  await page.locator("#shop").selectOption(firstShop.value);
  const filteredResponse = await filteredResponsePromise;

  expect(filteredResponse.ok()).toBeTruthy();
  await expect(page.locator("#shop")).toHaveValue(firstShop.value);
  await expect(page.locator("#active-filters")).toContainText(firstShop.label);
  await expect(page).toHaveURL(new RegExp(`shop=${encodeURIComponent(firstShop.value)}`));

  await page.locator('[data-clear-filter="shop"]').click();
  await expect(page.locator("#shop")).toHaveValue("");
  await expect(page.locator("#active-filters")).not.toContainText(firstShop.label);
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
    id: 2,
    manufacturer: "TAD",
    manufacturer_id: "tad",
    raw_manufacturer: "TAD",
    model: "ME1TX",
    title: "TAD ME1TX",
    category: "スピーカー",
    primary_category_id: "speaker",
    category_ids: ["speaker"],
    price_yen: 980000,
    previous_price_yen: null,
    source_url: "https://example.com/products/2",
  });

  await routeMeta(page);

  await page.route("**/api/products?**", async (route) => {
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
  await page.locator('[data-fav="1"]').click();

  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("hifiscout:favorites") || "[]"),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ id: 1, manufacturer: "LUXMAN", model: "D-10X" });

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
  await routeMeta(
    page,
    mockMeta({
      status: "warning",
      shops: [
        {
          key: "shop-a",
          name: "Shop A",
          intervalMinutes: 60,
          sync: { last_success_at: new Date(Date.now() - 10 * 60_000).toISOString() },
          health: {
            status: "healthy",
            lastSuccessAt: new Date(Date.now() - 10 * 60_000).toISOString(),
            ageMinutes: 10,
          },
        },
        {
          key: "shop-b",
          name: "Shop B",
          intervalMinutes: 60,
          sync: { last_success_at: new Date(Date.now() - 150 * 60_000).toISOString() },
          health: {
            status: "warning",
            lastSuccessAt: new Date(Date.now() - 150 * 60_000).toISOString(),
            ageMinutes: 150,
          },
        },
      ],
    }),
  );
  await page.route("**/api/products?**", (route) =>
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
  const requests = [];
  await page.route("**/api/products?**", async (route) => {
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
  const params = requests[0].searchParams;
  expect(params.get("manufacturer")).toBe("LUXMAN");
  expect(params.get("sort")).toBe("priceAsc");
  expect(params.has("inStock")).toBeFalsy();
  expect(params.get("newOnly")).toBe("true");
  expect(params.get("priceDropped")).toBe("true");
});

test("browser back restores previous filter state", async ({ page }) => {
  await routeMeta(page);
  await page.route("**/api/products?**", (route) =>
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
