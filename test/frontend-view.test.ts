import { test } from "vitest";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { escapeHtml, relativeTime, safeDate } from "../frontend/format.js";
import { pageNumbers, pageOffset, resultSummary } from "../frontend/pagination.js";
import { activityData, priceDropped } from "../frontend/product-activity.js";
import { safeExternalUrl, syncStatusSummary } from "../frontend/product-presentation.js";
import {
  EmptyProducts,
  HistoryContent,
  OffersContent,
  ProductCard,
} from "../frontend/public-components.js";
import type { MetaResponse } from "../src/api/contracts.js";
import type { DisplayOffer, DisplayProduct } from "../frontend/types.js";

const NOW = Date.parse("2026-08-12T00:00:00.000Z");
const shopName = (key: string) => (key === "hifido" ? "ハイファイ堂" : key);
const noop = () => undefined;

function offer(overrides: Partial<DisplayOffer> = {}): DisplayOffer {
  return {
    listing_product_id: 1,
    shop_key: "hifido",
    source_url: "https://example.test/p1",
    title: "TAD ME1TX ペア",
    condition_text: "中古",
    price_yen: 1_000_000,
    previous_price_yen: null,
    stock_status: "in_stock",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    last_activity_at: "2026-08-11T00:00:00.000Z",
    source_published_at: null,
    ...overrides,
  };
}

function product(overrides: Partial<DisplayProduct> = {}): DisplayProduct {
  return {
    key: "c-1",
    identity_kind: "catalog",
    catalog_product_id: 1,
    manufacturer: "TAD",
    manufacturer_id: "tad",
    model: "ME1TX",
    primary_category_id: "speaker_bookshelf",
    category: "ブックシェルフスピーカー",
    offer_count: 1,
    in_stock_offer_count: 1,
    sold_out_offer_count: 0,
    shop_count: 1,
    lowest_price_yen: 1_000_000,
    highest_price_yen: 1_000_000,
    latest_activity_at: "2026-08-11T00:00:00.000Z",
    newest_listed_at: "2026-08-01T00:00:00.000Z",
    has_new_offer: false,
    has_price_drop: false,
    representative_offer: offer(),
    ...overrides,
  };
}

function renderCard(value: DisplayProduct, favorite = false): string {
  return renderToStaticMarkup(
    createElement(ProductCard, {
      product: value,
      favorite,
      shopName,
      onManufacturer: noop,
      onFavorite: noop,
      onOffers: noop,
      now: NOW,
    }),
  );
}

function renderOffers(value: DisplayProduct, offers: DisplayOffer[]): string {
  return renderToStaticMarkup(
    createElement(OffersContent, {
      state: { kind: "ready", data: { product: value, offers } },
      shopName,
      onHistory: noop,
    }),
  );
}

function renderEmpty(favoriteMode: boolean, hasFavorites: boolean): string {
  return renderToStaticMarkup(
    createElement(EmptyProducts, { favoriteMode, hasFavorites, onClear: noop }),
  );
}

test("short page counts are listed in full", () => {
  assert.deepEqual(pageNumbers(1, 0), []);
  assert.deepEqual(pageNumbers(1, 3), [1, 2, 3]);
  assert.deepEqual(pageNumbers(4, 7), [1, 2, 3, 4, 5, 6, 7]);
});

test("long page counts always keep the first and last page reachable", () => {
  for (const [current, expected] of [
    [1, [1, 2, 3, 4, 5, 20]],
    [4, [1, 2, 3, 4, 5, 20]],
    [10, [1, 9, 10, 11, 20]],
    [17, [1, 16, 17, 18, 19, 20]],
    [20, [1, 16, 17, 18, 19, 20]],
  ] as const) {
    const numbers = pageNumbers(current, 20);
    assert.deepEqual(numbers, [...expected], `page ${current}`);
    assert.equal(numbers[0], 1);
    assert.equal(numbers.at(-1), 20);
  }
});

test("the result counter reports what is on screen, with more-available as a separate signal", () => {
  assert.deepEqual(
    resultSummary({ shown: 50, favoriteMode: false, currentPage: 1, totalPages: 2 }),
    { count: "50", label: "件を表示中", moreHidden: false },
  );
  assert.deepEqual(
    resultSummary({ shown: 12, favoriteMode: false, currentPage: 2, totalPages: 2 }),
    { count: "12", label: "件を表示中", moreHidden: true },
  );
});

test("favorites and failed loads never claim more results are available", () => {
  assert.equal(
    resultSummary({ shown: 3, favoriteMode: true, currentPage: 1, totalPages: 9 }).moreHidden,
    true,
  );
  assert.equal(
    resultSummary({ shown: 3, favoriteMode: true, currentPage: 1, totalPages: 9 }).label,
    "件のお気に入り",
  );
  assert.equal(
    resultSummary({
      shown: 0,
      favoriteMode: false,
      currentPage: 1,
      totalPages: 9,
      errorMessage: "商品の取得に失敗しました。",
    }).moreHidden,
    true,
  );
});

test("page offsets follow the fixed page size", () => {
  assert.equal(pageOffset(1), 0);
  assert.equal(pageOffset(3), 100);
  assert.equal(pageOffset(0), 0);
});

test("a product is new for 48 hours, then updated for 48 hours, never both", () => {
  const fresh = activityData(product({ newest_listed_at: "2026-08-11T12:00:00.000Z" }), NOW);
  assert.equal(fresh.isNew, true);
  assert.equal(fresh.isRecentlyUpdated, false);

  const updated = activityData(
    product({
      newest_listed_at: "2026-08-01T00:00:00.000Z",
      latest_activity_at: "2026-08-11T12:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(updated.isNew, false);
  assert.equal(updated.isRecentlyUpdated, true);
  assert.equal(updated.label, "更新");

  const stale = activityData(
    product({
      newest_listed_at: "2026-08-01T00:00:00.000Z",
      latest_activity_at: "2026-08-02T00:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(stale.isRecentlyUpdated, false);
});

test("a never-changed product is labelled as a first observation", () => {
  const first = activityData(
    product({
      newest_listed_at: "2026-08-01T00:00:00.000Z",
      latest_activity_at: "2026-08-01T00:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(first.label, "初回観測");
});

test("a price drop is the aggregate the server computed across offers", () => {
  assert.equal(priceDropped(product({ has_price_drop: true })), true);
  assert.equal(priceDropped(product({ has_price_drop: false })), false);
});

test("React escapes retailer text and rejects unsafe external URLs", () => {
  const markup = renderCard(
    product({ model: '<img src=x onerror="alert(1)">', manufacturer: "A&B" }),
  );

  assert.doesNotMatch(markup, /<img src=x/u);
  assert.match(markup, /&lt;img src=x/u);
  assert.match(markup, /A&amp;B/u);
  assert.equal(safeExternalUrl("javascript:alert(1)"), "#");
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("a single-offer card keeps its direct product link and linked shop chip", () => {
  const markup = renderCard(product(), true);

  assert.match(markup, /aria-pressed="true"/u);
  assert.match(markup, /お気に入りから削除/u);
  assert.match(markup, /class="shop shop-hifido shop-new-arrivals-link"/u);
  assert.match(markup, /class="product-title-link" href="https:\/\/example\.test\/p1"/u);
  assert.match(markup, /data-fav="c-1"/u);
});

test("a multi-shop card leads to the comparison instead of one arbitrary shop", () => {
  const markup = renderCard(
    product({
      offer_count: 3,
      shop_count: 2,
      in_stock_offer_count: 2,
      sold_out_offer_count: 1,
      highest_price_yen: 1_200_000,
    }),
  );

  assert.match(markup, /class="shop shop-multiple">2店舗/u);
  assert.match(markup, /class="product-title-link" data-offers="c-1"/u);
  assert.match(markup, /3件の在庫を比較/u);
  assert.match(markup, /2\/3件が在庫あり/u);
  assert.match(markup, /￥1,000,000〜/u);
  assert.doesNotMatch(markup, /class="shop-link"/u);
});

test("a product with no price and no stock says so rather than inventing one", () => {
  const markup = renderCard(
    product({ lowest_price_yen: null, highest_price_yen: null, in_stock_offer_count: 0 }),
  );

  assert.match(markup, /価格不明/u);
  assert.match(markup, /在庫状態未確認/u);
  assert.match(markup, /aria-pressed="false"/u);
});

test("a product whose offers are all sold out is not labelled as unknown", () => {
  const markup = renderCard(
    product({ offer_count: 2, in_stock_offer_count: 0, sold_out_offer_count: 2 }),
  );

  assert.match(markup, /class="stock sold_out">売り切れ/u);
  assert.doesNotMatch(markup, /在庫状態未確認/u);
});

test("a migrated listing favorite keeps direct links without requesting server-only detail", () => {
  const markup = renderCard(product({ key: "legacy-7" }), true);

  assert.doesNotMatch(markup, /data-offers=/u);
  assert.doesNotMatch(markup, /商品詳細/u);
  assert.match(markup, /shop-new-arrivals-link/u);
  assert.match(markup, /href="https:\/\/example\.test\/p1"/u);
});

test("a card badges the newest applicable state and a price drop independently", () => {
  const markup = renderCard(
    product({ newest_listed_at: "2026-08-11T12:00:00.000Z", has_price_drop: true }),
  );

  assert.match(markup, /badge">NEW/u);
  assert.match(markup, /badge">PRICE DOWN/u);
  assert.doesNotMatch(markup, /UPDATED/u);
});

test("the offer list keeps what actually distinguishes two offers of the same model", () => {
  const markup = renderOffers(product({ offer_count: 2, shop_count: 2 }), [
    offer({ listing_product_id: 11, title: "TAD ME1TX 元箱付き", condition_text: "美品" }),
    offer({
      listing_product_id: 22,
      shop_key: "formusic",
      title: "TAD ME1TX",
      condition_text: "並品",
      price_yen: 900_000,
      previous_price_yen: 1_000_000,
      stock_status: "sold_out",
    }),
  ]);

  assert.match(markup, /2店舗 \/ 2件の在庫/u);
  assert.match(markup, /元箱付き/u);
  assert.match(markup, /美品/u);
  assert.match(markup, /並品/u);
  assert.match(markup, /data-history="11"/u);
  assert.match(markup, /data-history="22"/u);
  assert.match(markup, /<del>￥1,000,000<\/del>/u);
  assert.match(markup, /売り切れ/u);
  assert.equal((markup.match(/href="https:\/\/example\.test\/p1"/g) || []).length, 2);
});

test("an unresolved product says the comparison is unavailable, not that it failed", () => {
  const markup = renderOffers(
    product({ identity_kind: "unresolved_listing", catalog_product_id: null }),
    [offer()],
  );

  assert.match(markup, /他店の在庫と照合できていません/u);
  assert.doesNotMatch(markup, /件の在庫<\/p>/u);
});

test("empty states distinguish no favorites from no matches", () => {
  assert.match(renderEmpty(true, false), /お気に入りはまだありません/u);
  assert.match(renderEmpty(true, true), /条件に一致する商品はありません/u);
  assert.match(renderEmpty(false, false), /条件に一致する商品はありません/u);
});

test("sync status grades only enabled shops and prefers the reported status", () => {
  const meta = (shops: MetaResponse["shops"], status?: MetaResponse["status"]) =>
    ({ shops, manufacturers: [], categories: [], categoryFacets: [], status }) as MetaResponse;
  const shop = (key: string, health: string | null, enabled = true) =>
    ({
      key,
      name: key,
      enabled,
      intervalMinutes: 30,
      sync: null,
      health: health ? ({ status: health } as never) : null,
    }) as MetaResponse["shops"][number];

  assert.equal(syncStatusSummary(meta([shop("a", "healthy")])).status, "healthy");
  assert.match(syncStatusSummary(meta([shop("a", "warning")])).summary, /1店舗で更新が遅れて/u);
  assert.match(syncStatusSummary(meta([shop("a", "critical")])).summary, /1店舗で更新に問題/u);
  assert.equal(syncStatusSummary(meta([shop("a", "critical", false)])).status, "healthy");
});

test("price history marks each drop and handles an empty series", () => {
  const listing = { manufacturer: "TAD", model: "ME1TX", title: "TAD ME1TX" };
  const markup = renderToStaticMarkup(
    createElement(HistoryContent, {
      state: {
        kind: "ready",
        data: {
          product: listing,
          history: [
            { price_yen: 1000, observed_at: "2026-08-01T00:00:00.000Z" },
            { price_yen: 900, observed_at: "2026-08-02T00:00:00.000Z" },
            { price_yen: 1200, observed_at: "2026-08-03T00:00:00.000Z" },
          ],
        },
      },
    }),
  );
  const empty = renderToStaticMarkup(
    createElement(HistoryContent, {
      state: { kind: "ready", data: { product: listing, history: [] } },
    }),
  );

  assert.equal((markup.match(/<span>↓<\/span>/g) || []).length, 1);
  assert.match(empty, /履歴はまだありません/u);
});

test("relative time buckets by minute, hour and day", () => {
  assert.equal(relativeTime("2026-08-11T23:59:30.000Z", NOW), "たった今");
  assert.equal(relativeTime("2026-08-11T23:01:00.000Z", NOW), "59分前");
  assert.equal(relativeTime("2026-08-11T23:00:00.000Z", NOW), "1時間前");
  assert.equal(relativeTime("2026-08-11T00:00:00.000Z", NOW), "1日前");
  assert.equal(relativeTime("2026-08-10T00:00:00.000Z", NOW), "2日前");
});

test("an unparseable timestamp is reported as unknown, but a null one is still the epoch", () => {
  assert.equal(safeDate("not a date"), null);
  assert.equal(relativeTime("not a date", NOW), "未取得");
  assert.notEqual(safeDate(null), null);
  assert.match(relativeTime(null, NOW), /日前$/u);
});
