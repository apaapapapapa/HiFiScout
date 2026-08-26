import type { Page, Route } from "@playwright/test";
import { expect, test } from "../fixtures/catalog-test.js";
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
  catalogPage,
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
  await routeProductDetail(page, (key) =>
    key === "c-1" ? { product: item, offers: [listing] } : null,
  );

  await catalogPage.goto("/?q=LUXMAN");
  await expect(catalogPage.card("c-1")).toBeVisible();

  await catalogPage.openOffers("c-1");
  await expect(catalogPage.offersDialog).toBeVisible();
  await expect(page).toHaveURL(/\/p\/c-1\?q=LUXMAN$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/\?q=LUXMAN$/);
  await expect(catalogPage.offersDialog).not.toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/p\/c-1\?q=LUXMAN$/);
  await expect(catalogPage.offersDialog).toBeVisible();
});
