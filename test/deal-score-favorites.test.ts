import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { sortFavorites } from "../frontend/favorites.js";
import type { DisplayProduct } from "../frontend/types.js";

function product(key: string, current: number | null, median: number | null): DisplayProduct {
  return {
    key,
    identity_kind: "catalog",
    catalog_product_id: Number(key.replace(/\D/gu, "")) || 1,
    manufacturer: "TAD",
    manufacturer_id: "tad",
    model: key,
    primary_category_id: "digital-player",
    category: "デジタルプレーヤー",
    offer_count: 1,
    in_stock_offer_count: current == null ? 0 : 1,
    sold_out_offer_count: 0,
    shop_count: 1,
    lowest_price_yen: current,
    highest_price_yen: current,
    latest_activity_at: "2026-08-28T00:00:00.000Z",
    newest_listed_at: "2026-08-28T00:00:00.000Z",
    has_new_offer: false,
    has_price_drop: false,
    representative_offer:
      current == null
        ? null
        : {
            listing_product_id: 1,
            shop_key: "example",
            source_url: "https://example.com/item",
            title: key,
            condition_text: "中古",
            presentation_color: "",
            price_yen: current,
            previous_price_yen: null,
            stock_status: "in_stock",
            first_seen_at: "2026-08-28T00:00:00.000Z",
            last_seen_at: "2026-08-28T00:00:00.000Z",
            last_activity_at: "2026-08-28T00:00:00.000Z",
            source_published_at: null,
          },
    ...(median == null
      ? {}
      : {
          price_index: {
            asking_sample_count: 4,
            asking_median_yen: median,
            asking_min_yen: median,
            asking_max_yen: median,
            recent_asking_median_yen: median,
            listing_end_sample_count: 0,
            listing_end_median_yen: null,
            sold_out_signal_count: 0,
            deactivated_signal_count: 0,
            listing_end_observations: [],
            last_computed_at: "2026-08-28T00:00:00.000Z",
          },
        }),
  };
}

test("favorite deal-score sort is best-deal first with missing indexes last", () => {
  const overpriced = product("c-1", 110_000, 100_000);
  const unranked = product("c-2", 70_000, null);
  const bargain = product("c-3", 80_000, 100_000);

  assert.deepEqual(
    sortFavorites([overpriced, unranked, bargain], "dealScore").map((item) => item.key),
    ["c-3", "c-1", "c-2"],
  );
});
