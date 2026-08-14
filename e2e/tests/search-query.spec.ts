import { expect, test } from "@playwright/test";
import { offer, product, routeProductSearch } from "./product-fixtures.js";

test("multi-word search is sent to the product API unchanged and renders its result", async ({
  page,
}) => {
  await page.route("**/api/meta", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "healthy",
        shops: [],
        manufacturers: ["TAD"],
        categories: ["DAC"],
        categoryFacets: [],
      }),
    }),
  );

  await routeProductSearch(page, (url) => {
    const items =
      url.searchParams.get("q") === "TAD 1000"
        ? [
            product({
              key: "c-1000",
              catalog_product_id: 1000,
              manufacturer: "TAD",
              manufacturer_id: "tad",
              model: "D1000MK2",
              primary_category_id: "dac",
              category: "DAC",
              lowest_price_yen: 500000,
              highest_price_yen: 500000,
              has_price_drop: false,
              representative_offer: offer({
                listing_product_id: 1000,
                title: "TAD D1000MK2",
                price_yen: 500000,
                previous_price_yen: null,
                source_url: "https://example.com/tad-d1000mk2",
              }),
            }),
          ]
        : [];
    return {
      items,
      hasMore: false,
      nextCursor: null,
      totalCount: items.length,
      totalPages: items.length ? 1 : 0,
    };
  });

  await page.goto("/");
  const searchRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/product-search" && url.searchParams.get("q") === "TAD 1000";
  });
  await page.locator("#q").fill("TAD 1000");
  await searchRequest;

  await expect(page.getByRole("link", { name: "D1000MK2" })).toBeVisible();
});
