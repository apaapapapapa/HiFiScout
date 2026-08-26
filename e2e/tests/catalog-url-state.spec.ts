import type { Page, Route } from "@playwright/test";
import { expect, test } from "../fixtures/catalog-test.js";
import { offer, product as productItem } from "./product-fixtures.js";
import type { JsonObject } from "./product-fixtures.js";

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

/** Recently listed, so the "48時間以内の新着" filter has something to keep. */
function product(overrides: JsonObject = {}) {
  const recent = new Date(Date.now() - 60 * 60_000).toISOString();
  return productItem({
    latest_activity_at: recent,
    newest_listed_at: recent,
    has_new_offer: true,
    representative_offer: offer({ first_seen_at: recent, last_activity_at: recent }),
    ...overrides,
  });
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
test("the URL is sanitized before the catalog script reads it", async ({ page, catalogPage }) => {
  await routeMeta(page);
  await page.route("**/api/product-search?**", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], hasMore: false, nextCursor: null }),
    }),
  );

  const productRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/product-search" && request.method() === "GET";
  });

  const longQuery = "x".repeat(101);
  await catalogPage.goto(
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
  await expect(catalogPage.searchInput).toHaveValue("");
  await expect(catalogPage.sort).toHaveValue("newest");
  await expect(catalogPage.products).not.toContainText("商品の取得に失敗しました。");
});

test("new and price-drop checkboxes update both the URL and product API query", async ({
  page,
  catalogPage,
}) => {
  await routeMeta(page);
  await page.route("**/api/product-search?**", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [product()], hasMore: false, nextCursor: null }),
    }),
  );

  await catalogPage.goto();

  const newRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/product-search" && url.searchParams.get("newOnly") === "true";
  });
  await catalogPage.enableRecentOnly();
  const newRequest = await newRequestPromise;
  expect(new URL(newRequest.url()).searchParams.get("newOnly")).toBe("true");
  await expect(page).toHaveURL(/newOnly=true/);

  const droppedRequestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/product-search" && url.searchParams.get("priceDropped") === "true"
    );
  });
  await catalogPage.enablePriceDropped();
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
test("the result counter is reapplied after a filter change", async ({ page, catalogPage }) => {
  await routeMeta(page);
  await page.route("**/api/product-search?**", (route: Route) => {
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

  await catalogPage.goto();
  await expect(catalogPage.count).toHaveText("1");
  await expect(catalogPage.moreAvailable).toBeVisible();

  await catalogPage.enablePriceDropped();
  await expect(catalogPage.moreAvailable).toBeHidden();
});

test("healthy metadata renders the simple normal sync summary", async ({ page, catalogPage }) => {
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
  await page.route("**/api/product-search?**", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], hasMore: false, nextCursor: null }),
    }),
  );

  await catalogPage.goto();
  await expect(catalogPage.syncSummaryText).toHaveText("データ更新 正常");
  await catalogPage.openSyncDetails();
  await expect(catalogPage.syncStatusDetails).toContainText("12分前");
  await expect(catalogPage.syncStatusDetails).toContainText("停止中");
});
