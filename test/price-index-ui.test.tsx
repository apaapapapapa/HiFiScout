import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vite-plus/test";

import { favoriteSnapshot } from "../frontend/favorites.js";
import {
  ProductPriceIndexSummary,
  RelativePriceBadge,
  productPriceIndex,
  relativePriceBadge,
} from "../frontend/price-index-ui.js";
import type { DisplayProduct } from "../frontend/types.js";

function product(overrides: Partial<DisplayProduct> = {}): DisplayProduct {
  return {
    key: "c-12",
    identity_kind: "catalog",
    catalog_product_id: 12,
    manufacturer: "TAD",
    manufacturer_id: "tad",
    model: "D1000TX",
    primary_category_id: "digital-player",
    category: "デジタルプレーヤー",
    offer_count: 2,
    in_stock_offer_count: 2,
    sold_out_offer_count: 0,
    shop_count: 2,
    lowest_price_yen: 246_000,
    highest_price_yen: 280_000,
    latest_activity_at: "2026-08-28T00:00:00.000Z",
    newest_listed_at: "2026-08-27T00:00:00.000Z",
    has_new_offer: false,
    has_price_drop: false,
    representative_offer: {
      listing_product_id: 100,
      shop_key: "example",
      source_url: "https://example.com/item/100",
      title: "TAD D1000TX",
      condition_text: "中古",
      presentation_color: "SILVER",
      price_yen: 246_000,
      previous_price_yen: null,
      stock_status: "in_stock",
      first_seen_at: "2026-08-27T00:00:00.000Z",
      last_seen_at: "2026-08-28T00:00:00.000Z",
      last_activity_at: "2026-08-28T00:00:00.000Z",
      source_published_at: null,
    },
    price_index: {
      asking_sample_count: 8,
      asking_listing_count: 5,
      asking_shop_count: 2,
      latest_asking_observed_at: "2026-08-28T00:00:00.000Z",
      asking_median_yen: 300_000,
      asking_min_yen: 240_000,
      asking_max_yen: 390_000,
      recent_asking_median_yen: 310_000,
      listing_end_sample_count: 3,
      listing_end_median_yen: 285_000,
      sold_out_signal_count: 2,
      deactivated_signal_count: 1,
      listing_end_observations: [
        {
          price_yen: 280_000,
          observed_at: "2026-08-26T03:00:00.000Z",
          signal_kind: "sold_out",
        },
        {
          price_yen: 290_000,
          observed_at: "2026-08-20T04:00:00.000Z",
          signal_kind: "deactivated",
        },
      ],
      last_computed_at: "2026-08-28T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("relative price badge compares the current lowest offer with the asking median", () => {
  const badge = relativePriceBadge(product());

  assert.deepEqual(badge, {
    label: "出品中央値比 −18%",
    title: "表示中の最安出品価格は出品ごとの最新価格の中央値より18%低い水準です",
    direction: "below",
  });
  const html = renderToStaticMarkup(<RelativePriceBadge product={product()} />);
  assert.match(html, /出品中央値比 −18%/);
  assert.match(html, /<details/);
  assert.match(html, /各出品の最新価格を1件ずつ/);
  assert.match(html, /絞り込み後の価格/);
  assert.match(html, /成約価格ではなく/);
});

test("a product without a valid price index renders no badge or summary", () => {
  const withoutIndex = product({ price_index: undefined });

  assert.equal(productPriceIndex(withoutIndex), null);
  assert.equal(relativePriceBadge(withoutIndex), null);
  assert.equal(renderToStaticMarkup(<RelativePriceBadge product={withoutIndex} />), "");
  assert.equal(renderToStaticMarkup(<ProductPriceIndexSummary product={withoutIndex} />), "");
});

test("price-index detail keeps asking and listing-end evidence separate and dated", () => {
  const html = renderToStaticMarkup(<ProductPriceIndexSummary product={product()} />);

  assert.match(html, /出品価格の相場/);
  assert.match(html, /直近90日中央値/);
  assert.match(html, /掲載終了時価格/);
  assert.match(html, /売り切れ表示を確認/);
  assert.match(html, /掲載終了を確認/);
  assert.match(html, /2026-08-26T03:00:00.000Z/);
  assert.match(html, /<time[^>]*>2026[^<]*<\/time>/);
  assert.match(html, /販売実績を示すものではありません/);
  assert.doesNotMatch(html, /成約価格|取引価格|売買価格/);
});

test("favorite snapshots preserve the validated aggregate used by the card badge", () => {
  const original = product();
  const snapshot = favoriteSnapshot(original);

  assert.equal(snapshot.price_index?.asking_median_yen, 300_000);
  assert.equal(relativePriceBadge(snapshot)?.label, "出品中央値比 −18%");
  assert.deepEqual(
    snapshot.price_index?.listing_end_observations,
    original.price_index?.listing_end_observations,
  );
  assert.notEqual(
    snapshot.price_index?.listing_end_observations,
    original.price_index?.listing_end_observations,
  );
});

test("older Step 3 payloads without observation arrays remain renderable", () => {
  const legacyIndex = { ...product().price_index } as Record<string, unknown>;
  delete legacyIndex.listing_end_observations;
  const legacy = product({ price_index: legacyIndex as DisplayProduct["price_index"] });

  const index = productPriceIndex(legacy);
  assert.ok(index);
  assert.deepEqual(index.listing_end_observations, []);
  assert.match(
    renderToStaticMarkup(<ProductPriceIndexSummary product={legacy} />),
    /掲載終了時価格/,
  );
});

test("old favorite payloads keep their summary but cannot infer independent evidence from observation count", () => {
  const original = product();
  delete original.price_index!.asking_listing_count;
  const snapshot = favoriteSnapshot(original);
  assert.equal(snapshot.price_index?.asking_sample_count, 8);
  assert.equal(relativePriceBadge(snapshot), null);
});
