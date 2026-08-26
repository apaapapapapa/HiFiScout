import { expect, test, type Page, type Route } from "@playwright/test";
import { offer, product, routeProductDetail, routeProductSearch } from "./product-fixtures.js";

async function routeMeta(page: Page): Promise<void> {
  await page.route("**/api/meta", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "healthy",
        shops: [
          {
            key: "shop-a",
            name: "Shop A",
            enabled: true,
            intervalMinutes: 60,
            sync: null,
            health: null,
          },
        ],
        manufacturers: ["LUXMAN"],
        categories: [],
        categoryFacets: [],
      }),
    }),
  );
}

test("opening product detail writes a permalink and Back/Forward close and reopen it", async ({
  page,
}) => {
  const listing = offer({
    listing_product_id: 11,
    shop_key: "shop-a",
    title: "LUXMAN D-10X",
    source_url: "https://example.com/d10x",
  });
  const item = product({ key: "c-1", model: "D-10X", representative_offer: listing });

  await routeMeta(page);
  await routeProductSearch(page, () => ({
    items: [item],
    hasMore: false,
    nextCursor: null,
    totalCount: 1,
    totalPages: 1,
  }));
  await routeProductDetail(page, (key) => (key === "c-1" ? { product: item, offers: [listing] } : null));

  await page.goto("/?q=LUXMAN");
  await expect(page.locator('.card[data-key="c-1"]')).toBeVisible();

  await page.locator('.card[data-key="c-1"] [data-offers]').last().click();
  await expect(page.locator("#offers-dialog")).toBeVisible();
  await expect(page).toHaveURL(/\/p\/c-1\?q=LUXMAN$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/\?q=LUXMAN$/);
  await expect(page.locator("#offers-dialog")).not.toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/p\/c-1\?q=LUXMAN$/);
  await expect(page.locator("#offers-dialog")).toBeVisible();
});
