import type { Page, Route } from "@playwright/test";
import { expect, test } from "../fixtures/catalog-test.js";
import { offer, product, routeProductDetail, routeProductSearch } from "./product-fixtures.js";

/**
 * The Phase 4 promise, end to end: one product per model rather than one card per shop.
 *
 * The grouping and filter SQL is asserted in the repository unit tests; what needs a browser is
 * the part no unit test can see — that a single card leads to the comparison, that the offers
 * arrive only when asked for, and that a shop link still points at the shop's own page.
 */

const SHOPS = [
  { key: "shop-a", name: "Shop A" },
  { key: "shop-b", name: "Shop B" },
  { key: "shop-c", name: "Shop C" },
];

async function routeMeta(page: Page): Promise<void> {
  await page.route("**/api/meta", (route: Route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "healthy",
        shops: SHOPS.map((shop) => ({
          ...shop,
          enabled: true,
          intervalMinutes: 60,
          sync: null,
          health: null,
        })),
        manufacturers: ["LUXMAN"],
        categories: [],
        categoryFacets: [],
      }),
    }),
  );
}

const OFFERS = [
  offer({
    listing_product_id: 11,
    shop_key: "shop-a",
    title: "LUXMAN D-10X 元箱付き",
    condition_text: "美品",
    price_yen: 698000,
    previous_price_yen: 748000,
    source_url: "https://example.com/shop-a/d10x",
  }),
  offer({
    listing_product_id: 22,
    shop_key: "shop-b",
    title: "LUXMAN D-10X",
    condition_text: "並品",
    price_yen: 712000,
    previous_price_yen: null,
    source_url: "https://example.com/shop-b/d10x",
  }),
  offer({
    listing_product_id: 33,
    shop_key: "shop-c",
    title: "LUXMAN D-10X 保証書欠品",
    condition_text: "訳あり",
    price_yen: 660000,
    previous_price_yen: null,
    stock_status: "sold_out",
    source_url: "https://example.com/shop-c/d10x",
  }),
];

const CROSS_SHOP_PRODUCT = product({
  offer_count: 3,
  in_stock_offer_count: 2,
  sold_out_offer_count: 1,
  shop_count: 3,
  lowest_price_yen: 660000,
  highest_price_yen: 712000,
  representative_offer: OFFERS[0],
});

test("three shops listing one model produce a single product result", async ({
  page,
  catalogPage,
}) => {
  await routeMeta(page);
  await routeProductSearch(page, () => ({
    items: [CROSS_SHOP_PRODUCT],
    hasMore: false,
    nextCursor: null,
    totalCount: 1,
    totalPages: 1,
  }));
  await routeProductDetail(page, (key) =>
    key === "c-1" ? { product: CROSS_SHOP_PRODUCT, offers: OFFERS } : null,
  );

  await catalogPage.goto();

  await expect(catalogPage.cards).toHaveCount(1);
  await expect(catalogPage.count).toHaveText("1");
  await expect(catalogPage.cardShop()).toHaveText("3店舗");
  await expect(catalogPage.cardPriceRow()).toContainText("〜");
  await expect(catalogPage.cardStock()).toContainText("2/3件が在庫あり");
});

test("opening a product reveals every shop's offer with what distinguishes them", async ({
  page,
  catalogPage,
}) => {
  await routeMeta(page);
  await routeProductSearch(page, () => ({
    items: [CROSS_SHOP_PRODUCT],
    hasMore: false,
    nextCursor: null,
  }));
  let detailRequests = 0;
  await routeProductDetail(page, (key) => {
    detailRequests += 1;
    return key === "c-1" ? { product: CROSS_SHOP_PRODUCT, offers: OFFERS } : null;
  });

  await catalogPage.goto();
  // Offers are not fetched for a page of cards nobody opened.
  await expect(catalogPage.cards).toHaveCount(1);
  expect(detailRequests).toBe(0);

  await catalogPage.openOffers("c-1");

  await expect(catalogPage.offersDialog).toBeVisible();
  await expect(catalogPage.offersDialog.locator(".offer")).toHaveCount(3);
  await expect(catalogPage.offersDialog).toContainText("Shop A");
  await expect(catalogPage.offersDialog).toContainText("Shop C");
  await expect(catalogPage.offersDialog).toContainText("元箱付き");
  await expect(catalogPage.offersDialog).toContainText("訳あり");
  await expect(catalogPage.offersDialog).toContainText("売り切れ");
  expect(detailRequests).toBe(1);
});

test("each offer links to its own shop, not to the product", async ({ page, catalogPage }) => {
  await routeMeta(page);
  await routeProductSearch(page, () => ({
    items: [CROSS_SHOP_PRODUCT],
    hasMore: false,
    nextCursor: null,
  }));
  await routeProductDetail(page, () => ({ product: CROSS_SHOP_PRODUCT, offers: OFFERS }));

  await catalogPage.goto();
  await catalogPage.openOffers("c-1");

  const links = catalogPage.offerLinks();
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toHaveAttribute("href", "https://example.com/shop-a/d10x");
  await expect(links.nth(2)).toHaveAttribute("href", "https://example.com/shop-c/d10x");
  await expect(links.nth(0)).toHaveAttribute("rel", "noopener noreferrer");
});

test("a shop filter narrows the card summary instead of contradicting it", async ({
  page,
  catalogPage,
}) => {
  await routeMeta(page);
  await routeProductSearch(page, (url) =>
    url.searchParams.get("shop") === "shop-b"
      ? {
          items: [
            product({
              offer_count: 1,
              in_stock_offer_count: 1,
              shop_count: 1,
              lowest_price_yen: 712000,
              highest_price_yen: 712000,
              has_price_drop: false,
              representative_offer: OFFERS[1],
            }),
          ],
          hasMore: false,
          nextCursor: null,
          totalCount: 1,
          totalPages: 1,
        }
      : {
          items: [CROSS_SHOP_PRODUCT],
          hasMore: false,
          nextCursor: null,
          totalCount: 1,
          totalPages: 1,
        },
  );

  await catalogPage.goto();
  await expect(catalogPage.cardShop()).toHaveText("3店舗");

  await catalogPage.selectShop("shop-b");

  await expect(catalogPage.cardShop()).toHaveText("Shop B");
  await expect(catalogPage.cardPriceRow()).not.toContainText("〜");
  await expect(catalogPage.cards).toHaveCount(1);
});

test("an unresolved listing stays searchable as a product of its own", async ({
  page,
  catalogPage,
}) => {
  const unresolved = product({
    key: "l-77",
    identity_kind: "unresolved_listing",
    catalog_product_id: null,
    model: "SQ-N150",
    representative_offer: offer({
      listing_product_id: 77,
      title: "LUXMAN SQ-N150",
      source_url: "https://example.com/shop-a/sq-n150",
    }),
  });
  await routeMeta(page);
  await routeProductSearch(page, () => ({
    items: [CROSS_SHOP_PRODUCT, unresolved],
    hasMore: false,
    nextCursor: null,
    totalCount: 2,
    totalPages: 1,
  }));
  await routeProductDetail(page, (key) =>
    key === "l-77" ? { product: unresolved, offers: [OFFERS[0]] } : null,
  );

  await catalogPage.goto();

  await expect(catalogPage.cards).toHaveCount(2);
  await expect(catalogPage.count).toHaveText("2");
  // A single-offer product links straight to the shop rather than to a comparison of one.
  await expect(catalogPage.productTitle("SQ-N150")).toHaveAttribute(
    "href",
    "https://example.com/shop-a/sq-n150",
  );

  await catalogPage.openOffers("l-77");
  await expect(catalogPage.offersDialog).toContainText("他店の在庫と照合できていません");
});

test("pagination totals count products, and page state survives back navigation", async ({
  page,
  catalogPage,
}) => {
  await routeMeta(page);
  await routeProductSearch(page, (url) => {
    const offsetPage = url.searchParams.get("offset") === "50" || url.searchParams.has("cursor");
    return {
      items: [
        offsetPage
          ? product({ key: "c-2", model: "L-507Z", representative_offer: OFFERS[1] })
          : CROSS_SHOP_PRODUCT,
      ],
      hasMore: !offsetPage,
      nextCursor: offsetPage ? null : "cursor-2",
      totalCount: 2,
      totalPages: 2,
    };
  });
  await routeProductDetail(page, () => ({ product: CROSS_SHOP_PRODUCT, offers: OFFERS }));

  await catalogPage.goto();
  await expect(catalogPage.pageIndicator(1)).toHaveAttribute("aria-current", "page");
  await expect(catalogPage.pageIndicator(2)).toBeVisible();

  await catalogPage.goToPage(2);
  await expect(catalogPage.cards).toHaveCount(1);
  await expect(catalogPage.card("c-2")).toBeVisible();

  await catalogPage.enableRecentOnly();
  await expect(page).toHaveURL(/newOnly=true/);
  await page.goBack();
  await expect(catalogPage.recentOnly).not.toBeChecked();
});
