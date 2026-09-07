import { expect, test } from "../fixtures/catalog-test.js";
import { product, offer, routeProductSearch, routeProductDetail } from "./product-fixtures.js";

test("market detail displays observation context and scrollable tables on mobile", async ({ page, catalogPage }) => {
  await catalogPage.useMobileViewport();
  await page.route("**/api/meta", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    status: "healthy", shops: [{ key: "shop-a", name: "Shop A", enabled: true, intervalMinutes: 60, sync: null, health: null }],
    manufacturers: ["LUXMAN"], categories: [], categoryFacets: [],
  }) }));
  const empty = { listing_count: 0, shop_count: 0, median_yen: null, min_yen: null, max_yen: null, first_observed_at: null, last_observed_at: null };
  const analysis = { version: 1, status: "ready", as_of: "2026-09-07T00:00:00.000Z",
    current_conditions: [{ ...empty, listing_count: 2, shop_count: 1, first_observed_at: "2026-09-01T00:00:00.000Z", last_observed_at: "2026-09-07T00:00:00.000Z", condition: "used", sale_unit: "pair" }],
    months: ["04", "05", "06", "07", "08", "09"].map((month) => ({ ...empty, month: `2026-${month}`, first_observed_listings: 0, sold_out_listings: 0, deactivated_listings: 0 })),
  };
  await routeProductSearch(page, () => ({ items: [product()], hasMore: false, nextCursor: null, totalCount: 1, totalPages: 1 }));
  let detailRequests = 0;
  await routeProductDetail(page, () => { detailRequests++; return { product: product({ market_analysis: analysis }), offers: [offer()] }; });
  await catalogPage.goto();
  await expect(catalogPage.cards).toHaveCount(1);
  expect(detailRequests).toBe(0);
  await catalogPage.openOffers("c-1");
  await catalogPage.offersDialog.getByText("状態別の価格帯・相場の推移", { exact: true }).click();
  const panel = catalogPage.offersDialog.locator(".market-analysis");
  await expect(panel).toContainText("成約価格ではありません");
  await expect(panel).toContainText("2件 / 1店舗");
  await expect(panel).toContainText("データ不足");
  await expect(panel).toContainText("ペア");
  expect(detailRequests).toBe(1);
  const table = panel.getByRole("region", { name: "月次の掲載価格と観測件数", exact: true });
  await table.focus();
  await expect(table).toBeFocused();
  const widths = await table.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(widths.scroll).toBeGreaterThan(widths.client);
  expect(widths.client).toBeLessThanOrEqual(390);
});
