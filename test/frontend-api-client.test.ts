import test from "node:test";
import assert from "node:assert/strict";

import {
  isMetaResponse,
  isProductHistoryResponse,
  isProductsResponse,
} from "../frontend/api-client.js";
import type { MetaResponse, ProductListItem } from "../src/api/contracts.js";

function product(overrides: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: 1,
    shop_key: "hifido",
    source_id: "source-1",
    manufacturer: "TAD",
    model: "ME1TX",
    title: "TAD ME1TX",
    category: "スピーカー",
    condition_text: "中古",
    price_yen: 1_000_000,
    stock_status: "in_stock",
    source_url: "https://example.test/1",
    first_seen_at: "2026-08-01T00:00:00.000Z",
    last_seen_at: "2026-08-14T00:00:00.000Z",
    last_changed_at: "2026-08-14T00:00:00.000Z",
    is_active: 1,
    previous_price_yen: 1_100_000,
    metadata_json: "{}",
    raw_manufacturer: "TAD",
    manufacturer_id: "tad",
    raw_category: "スピーカー",
    primary_category_id: "speaker_bookshelf",
    category_ids: ["speaker", "speaker_bookshelf"],
    classification_status: "classified",
    search_aliases: "TAD ME1TX",
    last_inventory_checked_at: null,
    inventory_check_failures: 0,
    last_inventory_check_attempt_at: null,
    last_activity_at: "2026-08-14T00:00:00.000Z",
    source_published_at: null,
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
  assert.equal(
    isProductsResponse({ ...valid, items: [{ ...product(), stock_status: "available" }] }),
    false,
  );
  assert.equal(
    isProductsResponse({ ...valid, items: [{ ...product(), category_ids: "speaker" }] }),
    false,
  );
  assert.equal(isProductsResponse({ ...valid, totalPages: -1 }), false);
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

test("history response guard validates both the product and every price point", () => {
  const valid = {
    product: product(),
    history: [{ price_yen: 1_000_000, observed_at: "2026-08-14T00:00:00.000Z" }],
  };
  assert.equal(isProductHistoryResponse(valid), true);
  assert.equal(
    isProductHistoryResponse({ ...valid, history: [{ price_yen: "1000000", observed_at: "x" }] }),
    false,
  );
  assert.equal(isProductHistoryResponse({ ...valid, product: { ...product(), id: "1" } }), false);
});
