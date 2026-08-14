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
    source_id: "source-1",
    manufacturer: "LUXMAN",
    manufacturer_id: "luxman",
    raw_manufacturer: "LUXMAN",
    model: "D-10X",
    title: "LUXMAN D-10X",
    category: "CD/SACDプレーヤー",
    raw_category: "CD/SACDプレーヤー",
    primary_category_id: "digital-disc-player",
    category_ids: ["digital-disc-player"],
    classification_status: "classified",
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
    is_active: 1,
    metadata_json: "{}",
    last_inventory_checked_at: null,
    inventory_check_failures: 0,
    last_inventory_check_attempt_at: null,
    source_published_at: null,
    ...overrides,
  };
}

function healthEntry({
  key,
  name,
  enabled,
  status,
  lastSuccessAt,
  ageMinutes,
}: {
  key: string;
  name: string;
  enabled: boolean;
  status: "healthy" | "disabled";
  lastSuccessAt: string | null;
  ageMinutes: number | null;
}) {
  return {
    shopKey: key,
    name,
    enabled,
    configured: true,
    intervalMinutes: 60,
    status,
    ageMinutes,
    reason: status === "disabled" ? "disabled" : "ok",
    lastSuccessAt,
    lastAttemptAt: lastSuccessAt,
    lastItemCount: null,
    consecutiveFailures: 0,
    lastError: null,
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

/**
 * Which parameters survive sanitization is asserted per-rule in
 * test/frontend-catalog-url-sanitizer.test.ts. What needs a real page is the ordering: the
 * bootstrap entry has to rewrite the address bar via `history.replaceState` *before* the catalog
 * script parses it and issues its first request. No unit test can observe that.
 */
test("the URL is sanitized before the catalog script reads it", async ({ page }) => {
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
  await page.goto(
    `/?q=${longQuery}&minPrice=abc&sort=invalid&inStock=maybe&favoritesOnly=true&cursor=bogus`,
  );

  // The first request already reflects the correction, which is what proves the ordering.
  const apiParams = new URL((await productRequestPromise).url()).searchParams;
  expect(apiParams.get("q")).toBeNull();
  expect(apiParams.get("cursor")).toBeNull();
  expect(apiParams.get("sort")).toBe("newest");

  // The address bar is corrected too, so a reload or share carries the cleaned link.
  expect([...new URL(page.url()).searchParams.keys()]).toEqual([]);

  // The controls were populated from the corrected URL rather than the original.
  await expect(page.locator("#q")).toHaveValue("");
  await expect(page.locator("#sort")).toHaveValue("newest");
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

/**
 * `resultSummary` is asserted per-case in test/frontend-view.test.ts. What this adds is that the
 * summary is recomputed and reapplied to the DOM when a filter change brings back a different page
 * shape — the wiring between a control event, the refetch and the counter.
 */
test("the result counter is reapplied after a filter change", async ({ page }) => {
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
  await expect(page.locator("#more-available")).toBeVisible();

  await page.locator("#priceDropped").check();
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
          intervalMinutes: 60,
          sync: null,
          health: healthEntry({
            key: "shop-a",
            name: "Shop A",
            enabled: true,
            status: "healthy",
            lastSuccessAt,
            ageMinutes: 12,
          }),
        },
        {
          key: "shop-disabled",
          name: "Disabled Shop",
          enabled: false,
          intervalMinutes: 60,
          sync: null,
          health: healthEntry({
            key: "shop-disabled",
            name: "Disabled Shop",
            enabled: false,
            status: "disabled",
            lastSuccessAt: null,
            ageMinutes: null,
          }),
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
