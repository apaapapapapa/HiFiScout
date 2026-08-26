import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vite-plus/test";

import { ProductCard } from "../frontend/public-components.js";
import type { DisplayProduct } from "../frontend/types.js";

function product(overrides: Partial<DisplayProduct> = {}): DisplayProduct {
  return {
    key: "l-1",
    identity_kind: "unresolved_listing",
    catalog_product_id: null,
    manufacturer: "ESOTERIC",
    manufacturer_id: "esoteric",
    model: "Grandioso P1 + Grandioso D1",
    primary_category_id: "transport",
    category_ids: ["transport", "digital"],
    category: "トランスポート",
    offer_count: 1,
    in_stock_offer_count: 1,
    sold_out_offer_count: 0,
    shop_count: 1,
    lowest_price_yen: 1_000_000,
    highest_price_yen: 1_000_000,
    latest_activity_at: "2026-08-27T00:00:00.000Z",
    newest_listed_at: "2026-08-27T00:00:00.000Z",
    has_new_offer: false,
    has_price_drop: false,
    representative_offer: {
      listing_product_id: 1,
      shop_key: "hifido",
      source_url: "https://example.test/set-1",
      title: "ESOTERIC Grandioso P1 SACDトランスポート + Grandioso D1 DAC",
      condition_text: "中古",
      presentation_color: "",
      price_yen: 1_000_000,
      previous_price_yen: null,
      stock_status: "in_stock",
      first_seen_at: "2026-08-27T00:00:00.000Z",
      last_seen_at: "2026-08-27T00:00:00.000Z",
      last_activity_at: "2026-08-27T00:00:00.000Z",
      source_published_at: null,
    },
    ...overrides,
  };
}

function render(value: DisplayProduct): string {
  return renderToStaticMarkup(
    createElement(ProductCard, {
      product: value,
      favorite: false,
      shopName: () => "ハイファイ堂",
      onManufacturer: () => undefined,
      onFavorite: () => undefined,
      onOffers: () => undefined,
      now: Date.parse("2026-08-28T00:00:00.000Z"),
    }),
  );
}

test("a set card renders every direct category as a wrapping text chip", () => {
  const markup = render(product({ direct_category_ids: ["dac", "transport"] }));

  const dac = '<span class="category product-color">DAC</span>';
  const transport = '<span class="category product-color">トランスポート</span>';
  assert.ok(markup.includes(dac));
  assert.ok(markup.includes(transport));
  assert.ok(markup.indexOf(dac) < markup.indexOf(transport));
});

test("a one-category card keeps the exact pre-set category markup", () => {
  const markup = render(product({ direct_category_ids: ["transport"] }));

  assert.match(
    markup,
    /<div class="product-submeta"><span class="category">トランスポート<\/span>/,
  );
  assert.doesNotMatch(markup, /class="category product-color"/);
});

test("an old favorite without direct categories falls back to the legacy display category", () => {
  const markup = render(product({ direct_category_ids: undefined }));

  assert.match(
    markup,
    /<div class="product-submeta"><span class="category">トランスポート<\/span>/,
  );
  assert.doesNotMatch(markup, />DAC<\/span>/);
});
