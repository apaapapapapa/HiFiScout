import { test, expect } from "../harness-fixtures.js";
import type { AuctionOffer } from "../../src/api/auction-contracts.js";
import { product, offer } from "../tests/product-fixtures.js";
const at = "2026-09-22T01:00:00.000Z";
const stamp = Date.parse(at);
function item(id = "a100001"): AuctionOffer {
  return {
    source: "yahoo-auctions",
    auctionId: id,
    sourceUrl: `https://auctions.yahoo.co.jp/jp/auction/${id}`,
    catalogProductId: 12,
    manufacturer: "DENON",
    model: "PMA-1700NE",
    categoryId: "AMP.INTEGRATED",
    saleUnit: "pair",
    saleSubject: "main_unit",
    currentPrice: { amountYen: 1, tax: "inclusive", observedAt: at },
    buyNowPrice: { status: "none", observedAt: at },
    bidCount: { value: 0, observedAt: at },
    shipping: null,
    scheduledEndAt: { value: new Date(stamp + 20_000).toISOString(), observedAt: at },
    observedAt: at,
    displayState: "open",
    freshness: "fresh",
    freshUntil: new Date(stamp + 2 * 60 * 60_000).toISOString(),
  };
}
const result = (items = [item()], more = false) => ({
  items,
  hasMore: more,
  nextCursor: more ? "fixture-cursor" : null,
  observedAt: at,
  coverage: "partial",
  validUntil: new Date(stamp + 60_000).toISOString(),
});

test("auction facts stay distinct, pagination deduplicates IDs and filters preserve browser history", async ({
  page,
  mount,
}) => {
  const seen: URL[] = [];
  await page.route("**/api/auction-features", (route) =>
    route.fulfill({ json: { search: true, display: true } }),
  );
  await page.route("**/api/auctions?*", (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    return route.fulfill({
      json: url.searchParams.has("cursor")
        ? result([item(), item("a100002")])
        : result([item()], true),
    });
  });
  await page.clock.install({ time: new Date(at) });
  await mount("frontend/auctions/Default");
  await expect(page.getByRole("heading", { name: "PMA-1700NE", exact: true })).toHaveCount(1);
  await expect(page.getByText("設定なし（確認済み）")).toBeVisible();
  await expect(page.getByText("送料未確認")).toBeVisible();
  await expect(page.getByText("0件の観測")).toBeVisible();
  await page.getByRole("button", { name: "次の出品を読み込む" }).click();
  await expect(page.getByRole("heading", { name: "PMA-1700NE", exact: true })).toHaveCount(2);
  await page.getByText("条件を絞り込む", { exact: true }).click();
  expect((await page.getByLabel("型番（短い型番も入力可）").boundingBox())!.width).toBeGreaterThan(
    200,
  );
  await page.getByLabel("型番（短い型番も入力可）").fill("A8");
  await page.getByRole("button", { name: "条件を適用" }).click();
  await expect.poll(() => seen.at(-1)?.searchParams.get("model")).toBe("A8");
  expect(seen.at(-1)?.searchParams.has("cursor")).toBe(false);
  await page.goBack();
  await expect(page.getByLabel("型番（短い型番も入力可）")).toHaveValue("");
  await expect.poll(() => seen.at(-1)?.searchParams.has("model")).toBe(false);
  await expect(
    page.getByRole("link", { name: "Yahoo!オークションで確認 ↗" }).first(),
  ).toHaveAttribute("href", "https://auctions.yahoo.co.jp/jp/auction/a100001");
});
test("passing time removes an open claim and expires the visible response without fetching sellers", async ({
  page,
  mount,
}) => {
  let reads = 0;
  await page.route("**/api/auction-features", (route) =>
    route.fulfill({ json: { search: true, display: true } }),
  );
  await page.route("**/api/auctions?*", (route) => {
    reads++;
    return route.fulfill({ json: result() });
  });
  await page.clock.install({ time: new Date(at) });
  await mount("frontend/auctions/Default");
  await expect(page.getByText("開催中の観測あり")).toBeVisible();
  await page.clock.fastForward(21_000);
  await expect(page.getByRole("listitem").getByText("終了確認待ち", { exact: true })).toBeVisible();
  await page.clock.fastForward(41_000);
  await expect(page.getByText("表示の有効期限が切れました。再検索してください。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "PMA-1700NE", exact: true })).toHaveCount(0);
  expect(reads).toBe(1);
});
test("a disabled search performs no auction read and an unavailable detail keeps shop prices", async ({
  page,
  mount,
}) => {
  let reads = 0;
  await page.route("**/api/auction-features", (route) =>
    route.fulfill({ json: { search: false, display: false } }),
  );
  await page.route("**/api/auctions?*", (route) => {
    reads++;
    return route.fulfill({ status: 503, json: { error: "quota" } });
  });
  await page.clock.install({ time: new Date(at) });
  await mount("frontend/auctions/Default");
  await expect(page.getByText("オークション検索は現在公開していません。")).toBeVisible();
  expect(reads).toBe(0);
  await mount("frontend/auctions/Product");
  await expect(page.getByText("ショップの販売価格 ¥698,000")).toBeVisible();
  await expect(page.getByText(/ショップ情報は引き続き/)).toBeVisible();
  await expect(
    page.getByText("確認できる開催中の出品はありません。", { exact: false }),
  ).toHaveCount(0);
});
test("public product cards never fan out auction reads and one-yen bids do not replace shop prices", async ({
  page,
  mount,
}) => {
  let auctionReads = 0;
  const p = product({ key: "c-12", catalog_product_id: 12 });
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/auction-features")
        return route.fulfill({ json: { search: true, display: true } });
      if (url.pathname === "/api/meta")
        return route.fulfill({
          json: {
            status: "healthy",
            shops: [
              {
                key: "shop-a",
                name: "テスト販売店",
                enabled: true,
                intervalMinutes: 60,
                sync: null,
                health: null,
              },
            ],
            manufacturers: [],
            manufacturerFacets: [],
            categories: [],
            categoryFacets: [],
          },
        });
      if (url.pathname === "/api/product-search")
        return route.fulfill({
          json: { items: [p], hasMore: false, nextCursor: null, totalCount: 1, totalPages: 1 },
        });
      if (url.pathname === "/api/product-search/c-12")
        return route.fulfill({ json: { product: p, offers: [offer()] } });
      if (url.pathname === "/api/auctions") {
        auctionReads++;
        return route.fulfill({ json: result() });
      }
      return route.fulfill({ json: { items: [] } });
    },
  );
  await page.clock.install({ time: new Date(at) });
  await mount("frontend/public-app/Default");
  await expect(page.getByRole("link", { name: "オークション検索", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "商品詳細", exact: true }).first()).toBeVisible();
  expect(auctionReads).toBe(0);
  await page.locator("[data-offers]").first().click();
  await expect(
    page.getByRole("heading", { name: "Yahoo!オークション", exact: true }),
  ).toBeVisible();
  expect(auctionReads).toBe(1);
  await expect(
    page.locator("#offers-dialog").getByText("¥698,000", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.locator("#offers-dialog").getByText("¥1", { exact: true })).toBeVisible();
});
test("mobile auction layout escapes catalog names and stays within the viewport", async ({
  page,
  mount,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/auction-features", (route) =>
    route.fulfill({ json: { search: true, display: true } }),
  );
  await page.route("**/api/auctions?*", (route) =>
    route.fulfill({
      json: result([
        {
          ...item(),
          model: "PMA-1700NE <img src=x onerror=alert(1)>",
          buyNowPrice: { status: "unknown" },
        },
      ]),
    }),
  );
  await page.clock.install({ time: new Date(at) });
  await mount("frontend/auctions/Default");
  await expect(page.getByRole("heading", { name: /<img src=x/ })).toBeVisible();
  await expect(page.locator(".auction-results img")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByText("条件を絞り込む", { exact: true }).click();
  await expect(page.getByLabel("現在価格の上限（円）")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
