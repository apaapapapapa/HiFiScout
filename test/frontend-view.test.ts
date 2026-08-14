import test from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, relativeTime, safeDate } from "../frontend/format.js";
import { pageNumbers, pageOffset, resultSummary } from "../frontend/pagination.js";
import { activityData, priceDropped } from "../frontend/product-activity.js";
import {
  emptyState,
  paginationMarkup,
  priceHistoryMarkup,
  productCard,
  syncStatusSummary,
} from "../frontend/product-view.js";
import type { MetaResponse } from "../src/api/contracts.js";
import type { DisplayProduct } from "../frontend/types.js";

const NOW = Date.parse("2026-08-12T00:00:00.000Z");

function product(overrides: Partial<DisplayProduct> = {}): DisplayProduct {
  return {
    id: 1,
    shop_key: "hifido",
    manufacturer: "TAD",
    manufacturer_id: "tad",
    raw_manufacturer: "TAD",
    model: "ME1TX",
    title: "TAD ME1TX",
    category: "スピーカー",
    raw_category: "スピーカー",
    primary_category_id: "speaker",
    condition_text: "中古",
    price_yen: 1_000_000,
    previous_price_yen: null,
    stock_status: "in_stock",
    source_url: "https://example.test/p1",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_seen_at: "2026-08-11T00:00:00.000Z",
    last_activity_at: "2026-08-11T00:00:00.000Z",
    last_changed_at: "2026-08-11T00:00:00.000Z",
    search_aliases: "",
    category_ids: ["speaker"],
    ...overrides,
  };
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
  // Favorites are the whole stored set, so there is no next page to hint at.
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

test("the pager marks the current page and elides gaps", () => {
  const markup = paginationMarkup(pageNumbers(10, 20), 10, false);
  assert.equal((markup.match(/page-ellipsis/g) || []).length, 2);
  assert.match(markup, /class="page-button active" data-page="10"[^>]*aria-current="page"/u);
  assert.doesNotMatch(markup, /disabled/u);
  assert.match(paginationMarkup([1, 2], 1, true), /disabled/u);
});

test("a listing is new for 48 hours, then updated for 48 hours, never both", () => {
  const fresh = activityData(product({ first_seen_at: "2026-08-11T12:00:00.000Z" }), NOW);
  assert.equal(fresh.isNew, true);
  assert.equal(fresh.isRecentlyUpdated, false);

  const updated = activityData(
    product({
      first_seen_at: "2026-08-01T00:00:00.000Z",
      last_activity_at: "2026-08-11T12:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(updated.isNew, false);
  assert.equal(updated.isRecentlyUpdated, true);
  assert.equal(updated.label, "更新");

  const stale = activityData(
    product({
      first_seen_at: "2026-08-01T00:00:00.000Z",
      last_activity_at: "2026-08-02T00:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(stale.isRecentlyUpdated, false);
});

test("a never-changed listing is labelled as a first observation", () => {
  const first = activityData(
    product({
      first_seen_at: "2026-08-01T00:00:00.000Z",
      last_activity_at: "2026-08-01T00:00:00.000Z",
    }),
    NOW,
  );
  assert.equal(first.label, "初回観測");
});

test("a price drop needs both prices present", () => {
  assert.equal(priceDropped(product({ price_yen: 900, previous_price_yen: 1000 })), true);
  assert.equal(priceDropped(product({ price_yen: 1100, previous_price_yen: 1000 })), false);
  assert.equal(priceDropped(product({ price_yen: null, previous_price_yen: 1000 })), false);
  assert.equal(priceDropped(product({ previous_price_yen: null })), false);
});

test("retailer text is escaped before it reaches innerHTML", () => {
  const markup = productCard(
    product({ model: '<img src=x onerror="alert(1)">', manufacturer: "A&B" }),
    { favorite: false, shopName: "ハイファイ堂", now: NOW },
  );

  assert.doesNotMatch(markup, /<img src=x/u);
  assert.match(markup, /&lt;img src=x/u);
  assert.match(markup, /A&amp;B/u);
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("a card reflects favorite state and stock wording", () => {
  const favorited = productCard(product(), { favorite: true, shopName: "ハイファイ堂", now: NOW });
  assert.match(favorited, /aria-pressed="true"/u);
  assert.match(favorited, /お気に入りから削除/u);
  assert.match(favorited, /在庫あり/u);

  const soldOut = productCard(product({ stock_status: "sold_out" }), {
    favorite: false,
    shopName: "ハイファイ堂",
    now: NOW,
  });
  assert.match(soldOut, /売り切れ/u);
  assert.match(soldOut, /aria-pressed="false"/u);

  const unknown = productCard(product({ stock_status: null, price_yen: null }), {
    favorite: false,
    shopName: "ハイファイ堂",
    now: NOW,
  });
  assert.match(unknown, /在庫状態未確認/u);
  assert.match(unknown, /価格不明/u);
});

test("a card badges the newest applicable state and a price drop independently", () => {
  const markup = productCard(
    product({
      first_seen_at: "2026-08-11T12:00:00.000Z",
      price_yen: 900,
      previous_price_yen: 1000,
    }),
    { favorite: false, shopName: "ハイファイ堂", now: NOW },
  );

  assert.match(markup, /badge">NEW</u);
  assert.match(markup, /badge">PRICE DOWN</u);
  assert.doesNotMatch(markup, /UPDATED/u);
});

test("empty states distinguish no favorites from no matches", () => {
  assert.match(emptyState(true, false), /お気に入りはまだありません/u);
  assert.match(emptyState(true, true), /条件に一致する商品はありません/u);
  assert.match(emptyState(false, false), /条件に一致する商品はありません/u);
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
  // A deliberately disabled collector is not a problem.
  assert.equal(syncStatusSummary(meta([shop("a", "critical", false)])).status, "healthy");
});

test("price history marks each drop and handles an empty series", () => {
  const markup = priceHistoryMarkup(product(), [
    { price_yen: 1000, observed_at: "2026-08-01T00:00:00.000Z" },
    { price_yen: 900, observed_at: "2026-08-02T00:00:00.000Z" },
    { price_yen: 1200, observed_at: "2026-08-03T00:00:00.000Z" },
  ]);

  assert.equal((markup.match(/<span>↓<\/span>/g) || []).length, 1);
  assert.match(priceHistoryMarkup(product(), []), /履歴はまだありません/u);
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
  // Pre-existing: `new Date(null)` is the epoch, so a shop that never succeeded renders a huge
  // age rather than "未取得". Characterized here rather than changed by this refactor.
  assert.notEqual(safeDate(null), null);
  assert.match(relativeTime(null, NOW), /日前$/u);
});
