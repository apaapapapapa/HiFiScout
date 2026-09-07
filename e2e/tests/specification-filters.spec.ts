import { expect, test } from "../fixtures/catalog-test.js";
import { product, routeProductSearch } from "./product-fixtures.js";

test("specification drafts apply once, survive reload and saved feeds, and reject invalid values", async ({ page, catalogPage }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/meta", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ status: "healthy",
      shops: [{ key: "shop-a", name: "Shop A", enabled: true, intervalMinutes: 60, sync: null, health: null }],
      manufacturers: ["LUXMAN"], categories: ["AMP.PRE"], categoryFacets: [],
    }),
  }));
  const requests: URL[] = [];
  await routeProductSearch(page, (url) => {
    requests.push(url);
    return { items: [product()], hasMore: false, nextCursor: null, totalCount: 1, totalPages: 1 };
  });
  await catalogPage.goto();
  await expect(catalogPage.cards).toHaveCount(1);
  const initialCount = requests.length;
  await page.getByText("機能・仕様で詳しく絞り込む", { exact: true }).click();
  await page.locator("#spec-maxWidthMm").fill("４５０");
  await page.locator("#spec-minXlrOutputs").fill("3");
  expect(requests).toHaveLength(initialCount);
  await catalogPage.applyFiltersButton.click();
  await expect(page).toHaveURL(/maxWidthMm=450.*minXlrOutputs=3/);
  await expect.poll(() => requests.length).toBe(initialCount + 1);
  expect(requests.at(-1)?.searchParams.get("minXlrOutputs")).toBe("3");
  await page.reload();
  await expect(page.locator("#spec-maxWidthMm")).toHaveValue("450");
  await expect(catalogPage.cards).toHaveCount(1);
  await page.locator(".saved-searches > summary").click();
  await page.getByRole("textbox", { name: "検索名", exact: true }).fill("ラック用アンプ");
  await page.getByRole("button", { name: "この検索を保存", exact: true }).click();
  const stored = page.locator(".saved-searches li").filter({ hasText: "ラック用アンプ" });
  await expect(stored.locator('a[href^="/api/feed"]')).toHaveAttribute("href", /maxWidthMm=450.*minXlrOutputs=3/);
  await page.locator('[data-clear-filter="spec:maxWidthMm"]').click();
  await expect(page).not.toHaveURL(/maxWidthMm=/);
  await page.getByRole("button", { name: "ラック用アンプを検索", exact: true }).click();
  await expect(page).toHaveURL(/maxWidthMm=450/);
  const beforeInvalid = requests.length;
  await page.locator("#spec-minXlrOutputs").fill("2.5");
  await expect(catalogPage.applyFiltersButton).toBeDisabled();
  await expect(page.locator("#spec-error-minXlrOutputs")).toContainText("整数");
  expect(requests).toHaveLength(beforeInvalid);
  await expect(page).toHaveURL(/minXlrOutputs=3/);
});
