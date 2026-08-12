import { expect, test, type Page, type Route } from "@playwright/test";

type JsonObject = Record<string, unknown>;

function catalogMeta(overrides: JsonObject = {}) {
  return {
    status: "healthy",
    shops: [],
    manufacturers: ["LUXMAN"],
    categories: [],
    categoryFacets: [],
    ...overrides,
  };
}

function product(overrides: JsonObject = {}) {
  const recent = new Date(Date.now() - 60 * 60_000).toISOString();
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
    first_seen_at: recent,
    last_seen_at: recent,
    last_changed_at: recent,
    last_activity_at: recent,
    search_aliases: "SACD CD player",
    ...overrides,
  };
}

async function routeMeta(page: Page, meta: JsonObject = catalogMeta()): Promise<void> {
  await page.route("**/api/meta", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(meta),
    }),
  );
}

test("invalid catalog query parameters are sanitized before the product API request", async ({
  page,
}) => {
  await routeMeta(page);
  await page.route("**/api/products?**", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], hasMore: false, nextCursor: null }),
    }),
  );

  const productRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/products" && request.method() === "GET";
  });

  const longQuery = "x".repeat(101);
  const longShop = "s".repeat(81);
  await page.goto(
    `/?q=${longQuery}&shop=${longShop}&manufacturer=${longQuery}&category=${longQuery}&minPrice=abc&maxPrice=12x&sort=invalid&inStock=maybe&newOnly=yes&priceDropped=1&favoritesOnly=true&cursor=bogus`,
  );

  const productRequest = await productRequestPromise;
  const apiParams = new URL(productRequest.url()).searchParams;
  expect(apiParams.get("q")).toBeNull();
  expect(apiParams.get("shop")).toBeNull();
  expect(apiParams.get("manufacturer")).toBeNull();
  expect(apiParams.get("category")).toBeNull();
  expect(apiParams.get("minPrice")).toBeNull();
  expect(apiParams.get("maxPrice")).toBeNull();
  expect(apiParams.get("sort")).toBe("newest");
  expect(apiParams.get("inStock")).toBe("true");
  expect(apiParams.get("newOnly")).toBeNull();
  expect(apiParams.get("priceDropped")).toBeNull();
  expect(apiParams.get("favoritesOnly")).toBeNull();
  expect(apiParams.get("cursor")).toBeNull();

  await expect(page.locator("#q")).toHaveValue("");
  await expect(page.locator("#manufacturer")).toHaveValue("");
  await expect(page.locator("#minPrice")).toHaveValue("");
  await expect(page.locator("#maxPrice")).toHaveValue("");
  await expect(page.locator("#sort")).toHaveValue("newest");
  await expect(page.locator("#inStock")).toBeChecked();
  await expect(page.locator("#recentOnly")).not.toBeChecked();
  await expect(page.locator("#priceDropped")).not.toBeChecked();
  await expect(page.locator("#favoritesOnly")).not.toBeChecked();

  const pageParams = new URL(page.url()).searchParams;
  expect([...pageParams.keys()]).toEqual([]);
  await expect(page.locator("#products")).not.toContainText("商品の取得に失敗しました。");
});

test("new and price-drop checkboxes update both the URL and product API query", async ({
  page,
}) => {
  await routeMeta(page);
  await page.route("**/api/products?**", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [product()], hasMore: false, nextCursor: null }),
    }),
  );

  await page.goto("/");

  const newRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/products" && url.searchParams.get("newOnly") === "true";
  });
  await page.locator("#recentOnly").check();
  const newRequest = await newRequestPromise;
  expect(new URL(newRequest.url()).searchParams.get("newOnly")).toBe("true");
  await expect(page).toHaveURL(/newOnly=true/);

  const droppedRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/products" && url.searchParams.get("priceDropped") === "true";
  });
  await page.locator("#priceDropped").check();
  const droppedParams = new URL((await droppedRequestPromise).url()).searchParams;
  expect(droppedParams.get("newOnly")).toBe("true");
  expect(droppedParams.get("priceDropped")).toBe("true");
  await expect(page).toHaveURL(/priceDropped=true/);
});

test("result count distinguishes hasMore from the current page item count", async ({ page }) => {
  await routeMeta(page);
  await page.route("**/api/products?**", (route: Route) => {
    const params = new URL(route.request().url()).searchParams;
    const hasMore = params.get("priceDropped") !== "true";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [product()],
        hasMore,
        nextCursor: hasMore ? "cursor-2" : null,
        totalCount: hasMore ? 2 : 1,
        totalPages: hasMore ? 2 : 1,
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator("#count-label")).toHaveText("件を表示中");
  await expect(page.locator("#more-available")).toHaveText("さらに商品があります");
  await expect(page.locator("#more-available")).toBeVisible();

  await page.locator("#priceDropped").check();
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator("#count-label")).toHaveText("件を表示中");
  await expect(page.locator("#more-available")).toBeHidden();
});

test("healthy metadata renders the simple normal sync summary", async ({ page }) => {
  const lastSuccessAt = new Date(Date.now() - 12 * 60_000).toISOString();
  await routeMeta(
    page,
    catalogMeta({
      status: "healthy",
      shops: [
        {
          key: "shop-a",
          name: "Shop A",
          enabled: true,
          health: { status: "healthy", lastSuccessAt, ageMinutes: 12 },
        },
        {
          key: "shop-disabled",
          name: "Disabled Shop",
          enabled: false,
          health: { status: "disabled", lastSuccessAt: null, ageMinutes: null },
        },
      ],
    }),
  );
  await page.route("**/api/products?**", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], hasMore: false, nextCursor: null }),
    }),
  );

  await page.goto("/");
  await expect(page.locator("#sync-summary-text")).toHaveText("データ更新 正常");
  await page.locator("#sync-status summary").click();
  await expect(page.locator("#sync-status-details")).toContainText("12分前");
  await expect(page.locator("#sync-status-details")).toContainText("停止中");
});
