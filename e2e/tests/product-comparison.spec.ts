import { expect, test } from "../fixtures/catalog-test.js";
import { product } from "./product-fixtures.js";

test("a shared comparison survives the real public bootstrap and metadata initialization", async ({
  page,
  catalogPage,
}) => {
  const details: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/meta")
      return route.fulfill({
        json: {
          status: "healthy",
          shops: [],
          manufacturers: [],
          categories: [],
          categoryFacets: [],
        },
      });
    if (path === "/api/product-search")
      return route.fulfill({ json: { items: [], hasMore: false, nextCursor: null } });
    const key = path.split("/").at(-1)!;
    details.push(key);
    return route.fulfill({
      json: {
        product: product({ key, catalog_product_id: Number(key.slice(2)), model: `Model ${key}` }),
        offers: [],
      },
    });
  });
  await catalogPage.goto("/?compare=c-03,c-1,c-3");
  const comparison = page.getByRole("region", { name: "製品比較 (2/4)", exact: true });
  await expect(
    comparison.getByRole("columnheader", { name: "Model c-3", exact: true }),
  ).toBeVisible();
  await expect(comparison.getByRole("columnheader")).toHaveCount(3);
  expect(details.sort()).toEqual(["c-1", "c-3"]);
  expect(new URL(page.url()).searchParams.get("compare")).toBe("c-1,c-3");
});
