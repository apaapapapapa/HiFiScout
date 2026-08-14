/**
 * Shared product-search payloads for the browser tests.
 *
 * Not a spec file: Playwright only collects `*.spec.ts`, so this stays a plain module.
 *
 * The shapes here mirror `ProductSearchItem`/`ProductOffer` because the browser validates every
 * field it renders — a fixture that drifts from the contract fails as an "unexpected payload"
 * rather than as a wrong assertion, which is the point.
 */

import type { Page, Response, Route } from "@playwright/test";

export type JsonObject = Record<string, unknown>;

export function offer(overrides: JsonObject = {}) {
  return {
    listing_product_id: 1,
    shop_key: "shop-a",
    source_url: "https://example.com/products/1",
    title: "LUXMAN D-10X",
    condition_text: "中古",
    price_yen: 698000,
    previous_price_yen: 748000,
    stock_status: "in_stock",
    first_seen_at: "2026-08-11T08:00:00.000Z",
    last_seen_at: "2026-08-11T10:00:00.000Z",
    last_activity_at: "2026-08-11T10:00:00.000Z",
    source_published_at: null,
    ...overrides,
  };
}

export function product(overrides: JsonObject = {}) {
  return {
    key: "c-1",
    identity_kind: "catalog",
    catalog_product_id: 1,
    manufacturer: "LUXMAN",
    manufacturer_id: "luxman",
    model: "D-10X",
    primary_category_id: "digital-disc-player",
    category: "CD/SACDプレーヤー",
    offer_count: 1,
    in_stock_offer_count: 1,
    shop_count: 1,
    lowest_price_yen: 698000,
    highest_price_yen: 698000,
    latest_activity_at: "2026-08-11T10:00:00.000Z",
    newest_listed_at: "2026-08-11T08:00:00.000Z",
    has_new_offer: false,
    has_price_drop: true,
    representative_offer: offer(),
    ...overrides,
  };
}

export function isProductSearchRequest(response: Response): boolean {
  const url = new URL(response.url());
  return url.pathname === "/api/product-search" && response.request().method() === "GET";
}

export async function routeProductSearch(
  page: Page,
  handler: (url: URL) => JsonObject,
): Promise<void> {
  await page.route("**/api/product-search?**", async (route: Route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(handler(new URL(route.request().url()))),
    });
  });
}

export async function routeProductDetail(
  page: Page,
  handler: (key: string) => JsonObject | null,
): Promise<void> {
  await page.route("**/api/product-search/*", async (route: Route) => {
    const key = new URL(route.request().url()).pathname.split("/").pop() || "";
    const body = handler(key);
    await route.fulfill({
      status: body ? 200 : 404,
      contentType: "application/json",
      body: JSON.stringify(body ?? { error: "not_found" }),
    });
  });
}
