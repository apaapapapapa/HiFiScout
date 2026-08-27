import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vite-plus/test";

import { ProductCard } from "../frontend/public-components.js";
import { renderProductPermalinkHtml } from "../src/http/product-permalink.js";
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

test("a set card renders every direct category, in the order the API sent them", () => {
  const markup = render(
    product({
      direct_category_ids: ["dac", "transport"],
      direct_categories: ["DAC", "トランスポート"],
    }),
  );

  const dac = '<span class="category">DAC</span>';
  const transport = '<span class="category">トランスポート</span>';
  assert.ok(markup.includes(dac));
  assert.ok(markup.includes(transport));
  assert.ok(markup.indexOf(dac) < markup.indexOf(transport));
});

/**
 * The card carries no taxonomy of its own — the browser bundle may import only
 * `src/api/contracts.ts` from `src`, so ids alone cannot be turned into labels.
 */
test("ids without labels render nothing but the listing's own category", () => {
  const markup = render(product({ direct_category_ids: ["dac", "transport"] }));

  assert.match(
    markup,
    /<div class="product-submeta"><span class="category">トランスポート<\/span>/,
  );
  assert.doesNotMatch(markup, />DAC<\/span>/);
});

test("a one-category card keeps the exact pre-set category markup", () => {
  const markup = render(
    product({ direct_category_ids: ["transport"], direct_categories: ["トランスポート"] }),
  );

  assert.match(
    markup,
    /<div class="product-submeta"><span class="category">トランスポート<\/span>/,
  );
  assert.equal(markup.match(/class="category"/g)?.length, 1);
});

test("an old favorite without direct categories falls back to the legacy display category", () => {
  const markup = render(product({ direct_category_ids: undefined }));

  assert.match(
    markup,
    /<div class="product-submeta"><span class="category">トランスポート<\/span>/,
  );
  assert.doesNotMatch(markup, />DAC<\/span>/);
  assert.equal(markup.match(/class="category"/g)?.length, 1);
});

/**
 * Requirement 9 of #376: a set's permalink page renders the same ProductSearchItem the card does,
 * so the two must not disagree about which categories the listing is in.
 */
test("the permalink page shows the same categories as the card", () => {
  const item = product({
    direct_category_ids: ["dac", "transport"],
    direct_categories: ["DAC", "トランスポート"],
  });
  const card = render(item);
  const permalink = renderProductPermalinkHtml(
    {
      product: item,
      offers: item.representative_offer ? [item.representative_offer] : [],
    } as never,
    "https://example.test",
  );

  for (const label of item.direct_categories ?? []) {
    assert.ok(card.includes(`>${label}</span>`), `card must print ${label}`);
  }
  assert.ok(permalink.includes("<p>DAC／トランスポート</p>"), "permalink must print both");
});

test("a single-product permalink keeps the one label it always had", () => {
  const item = product({ direct_category_ids: undefined, direct_categories: undefined });
  const permalink = renderProductPermalinkHtml(
    {
      product: item,
      offers: item.representative_offer ? [item.representative_offer] : [],
    } as never,
    "https://example.test",
  );

  // Scoped to the category element: the page also prints the seller's title, which names both
  // products, so a whole-page match would pass for the wrong reason.
  assert.ok(permalink.includes("<p>トランスポート</p>"));
  assert.ok(!permalink.includes("<p>トランスポート／DAC</p>"));
});
