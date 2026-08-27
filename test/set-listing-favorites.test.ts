import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { isProductSearchItem } from "../frontend/api-client.js";
import {
  favoriteSnapshot,
  favoriteStoragePayload,
  parseFavoriteStorage,
} from "../frontend/favorites.js";
import type { DisplayProduct } from "../frontend/types.js";

function product(): DisplayProduct {
  return {
    key: "l-1",
    identity_kind: "unresolved_listing",
    catalog_product_id: null,
    manufacturer: "ESOTERIC",
    manufacturer_id: "esoteric",
    model: "Grandioso P1 + Grandioso D1",
    primary_category_id: "transport",
    category_ids: ["transport", "digital"],
    direct_category_ids: ["dac", "transport"],
    direct_categories: ["DAC", "トランスポート"],
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
  };
}

test("favorite snapshots round-trip direct categories", () => {
  const snapshot = favoriteSnapshot(product());
  assert.deepEqual(snapshot.direct_category_ids, ["dac", "transport"]);

  const store = parseFavoriteStorage(JSON.stringify([snapshot]), isProductSearchItem);
  assert.deepEqual(store.products.get("l-1")?.direct_category_ids, ["dac", "transport"]);
  assert.deepEqual(favoriteStoragePayload(store), [snapshot]);
});

test("pre-direct-category favorite snapshots remain valid", () => {
  const oldSnapshot = favoriteSnapshot(product());
  delete oldSnapshot.direct_category_ids;

  assert.equal(isProductSearchItem(oldSnapshot), true);
  const store = parseFavoriteStorage(JSON.stringify([oldSnapshot]), isProductSearchItem);
  assert.equal(store.products.has("l-1"), true);
  assert.equal(store.products.get("l-1")?.direct_category_ids, undefined);
});

/**
 * A favorite is read back from localStorage, which anything can have written. The card maps over
 * the direct-category fields, so a truthy non-array must be rejected by the guard rather than
 * reaching the render and throwing there.
 */
test("a snapshot whose direct categories are not arrays is discarded, not rendered", () => {
  const sound = favoriteSnapshot({
    ...product(),
    direct_categories: ["DAC", "トランスポート"],
  });
  assert.equal(isProductSearchItem(sound), true);

  for (const malformed of [
    { ...sound, direct_category_ids: "dac" },
    { ...sound, direct_categories: "DAC" },
    { ...sound, direct_categories: [1] },
  ]) {
    assert.equal(isProductSearchItem(malformed), false, JSON.stringify(malformed));
  }
});
