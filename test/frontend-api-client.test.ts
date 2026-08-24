import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  isMetaResponse,
  isProductDetailResponse,
  isProductHistoryResponse,
  isProductSearchItem,
  isProductsResponse,
} from "../frontend/api-client.js";
import type { MetaResponse, ProductOffer, ProductSearchItem } from "../src/api/contracts.js";

function offer(overrides: Partial<ProductOffer> = {}): ProductOffer {
  return {
    listing_product_id: 1,
    shop_key: "hifido",
    source_url: "https://example.test/1",
    title: "TAD ME1TX",
    presentation_color: "",
    condition_text: "中古",
    price_yen: 1_000_000,
    previous_price_yen: 1_100_000,
    stock_status: "in_stock",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_seen_at: "2026-08-14T00:00:00.000Z",
    last_activity_at: "2026-08-14T00:00:00.000Z",
    source_published_at: null,
    ...overrides,
  };
}

function product(overrides: Partial<ProductSearchItem> = {}): ProductSearchItem {
  return {
    key: "c-1",
    identity_kind: "catalog",
    catalog_product_id: 1,
    manufacturer: "TAD",
    manufacturer_id: "tad",
    model: "ME1TX",
    primary_category_id: "speaker_bookshelf",
    category: "ブックシェルフ",
    offer_count: 2,
    in_stock_offer_count: 1,
    sold_out_offer_count: 1,
    shop_count: 2,
    lowest_price_yen: 1_000_000,
    highest_price_yen: 1_200_000,
    latest_activity_at: "2026-08-14T00:00:00.000Z",
    newest_listed_at: "2026-08-14T00:00:00.000Z",
    has_new_offer: true,
    has_price_drop: true,
    representative_offer: offer(),
    ...overrides,
  };
}

function meta(): MetaResponse {
  return {
    status: "healthy",
    shops: [
      {
        key: "hifido",
        name: "ハイファイ堂",
        enabled: true,
        intervalMinutes: 60,
        sync: null,
        health: null,
      },
    ],
    manufacturers: ["TAD"],
    categories: ["ブックシェルフ"],
    categoryFacets: [
      {
        id: "speaker_bookshelf",
        parentId: "speaker",
        order: 1,
        classifiable: true,
        filterable: true,
        name: "　ブックシェルフ",
        group: null,
        activeProductCount: 1,
      },
    ],
  };
}

test("product response guard validates the fields the UI consumes", () => {
  const valid = {
    items: [product()],
    hasMore: true,
    nextCursor: "cursor-2",
    totalCount: 2,
    totalPages: 2,
  };
  assert.equal(isProductsResponse(valid), true);
  assert.equal(isProductsResponse({ ...valid, hasMore: "yes" }), false);
  assert.equal(isProductsResponse({ ...valid, nextCursor: 2 }), false);
  assert.equal(isProductsResponse({ ...valid, items: [{ ...product(), key: "" }] }), false);
  assert.equal(
    isProductsResponse({ ...valid, items: [{ ...product(), identity_kind: "guess" }] }),
    false,
  );
  assert.equal(isProductsResponse({ ...valid, items: [{ ...product(), shop_count: "2" }] }), false);
  assert.equal(
    isProductsResponse({ ...valid, items: [{ ...product(), sold_out_offer_count: "1" }] }),
    false,
  );
  assert.equal(
    isProductsResponse({ ...valid, items: [{ ...product(), has_price_drop: 1 }] }),
    false,
  );
  assert.equal(isProductsResponse({ ...valid, totalPages: -1 }), false);
});

test("the nested representative offer is validated, not merely present", () => {
  assert.equal(isProductSearchItem(product({ representative_offer: null })), true);
  assert.equal(
    isProductSearchItem({
      ...product(),
      representative_offer: { ...offer(), stock_status: "available" },
    }),
    false,
  );
  assert.equal(
    isProductSearchItem({
      ...product(),
      representative_offer: { ...offer(), listing_product_id: "1" },
    }),
    false,
  );
});

test("detail response guard validates the product and every offer under it", () => {
  const valid = { product: product(), offers: [offer(), offer({ listing_product_id: 2 })] };
  assert.equal(isProductDetailResponse(valid), true);
  assert.equal(isProductDetailResponse({ ...valid, offers: [{ ...offer(), title: 7 }] }), false);
  assert.equal(isProductDetailResponse({ ...valid, product: { ...product(), key: 1 } }), false);
  assert.equal(isProductDetailResponse({ ...valid, offers: "none" }), false);
});

test("meta response guard rejects malformed nested shop and facet values", () => {
  const valid = meta();
  assert.equal(isMetaResponse(valid), true);
  assert.equal(
    isMetaResponse({ ...valid, shops: [{ ...valid.shops[0], enabled: "true" }] }),
    false,
  );
  assert.equal(
    isMetaResponse({
      ...valid,
      categoryFacets: [{ ...valid.categoryFacets[0], activeProductCount: "1" }],
    }),
    false,
  );
  assert.equal(isMetaResponse({ ...valid, manufacturers: ["TAD", 42] }), false);
});

test("history response guard validates the listing labels and every price point", () => {
  const listing = { manufacturer: "TAD", model: "ME1TX", title: "TAD ME1TX" };
  const valid = {
    product: listing,
    history: [{ price_yen: 1_000_000, observed_at: "2026-08-14T00:00:00.000Z" }],
  };
  assert.equal(isProductHistoryResponse(valid), true);
  assert.equal(
    isProductHistoryResponse({ ...valid, history: [{ price_yen: "1000000", observed_at: "x" }] }),
    false,
  );
  assert.equal(isProductHistoryResponse({ ...valid, product: { ...listing, model: 1 } }), false);
});
