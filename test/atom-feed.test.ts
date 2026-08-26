import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { escapeXml, productSearchAtomFeed } from "../src/api/atom-feed.js";
import {
  FEED_MAX_PAGE_SIZE,
  canonicalFeedQueryUrl,
  parseFeedQuery,
  validateFeedQuery,
} from "../src/api/feed-query.js";
import type { ProductSearchItem } from "../src/api/contracts.js";

function item(overrides: Partial<ProductSearchItem> = {}): ProductSearchItem {
  return {
    key: "c-42",
    identity_kind: "catalog",
    catalog_product_id: 42,
    manufacturer: "LUXMAN",
    manufacturer_id: "luxman",
    model: "L-507Z",
    primary_category_id: "integrated_amp",
    category: "プリメインアンプ",
    offer_count: 2,
    in_stock_offer_count: 1,
    sold_out_offer_count: 1,
    shop_count: 2,
    lowest_price_yen: 300000,
    highest_price_yen: 320000,
    latest_activity_at: "2026-08-25T10:00:00Z",
    newest_listed_at: "2026-08-24T10:00:00Z",
    has_new_offer: true,
    has_price_drop: false,
    representative_offer: {
      listing_product_id: 7,
      shop_key: "hifido",
      source_url: "https://example.test/item?a=1&b=2",
      title: 'LUXMAN <L-507Z> "中古" & demo\u0001',
      condition_text: "美品 & 元箱あり",
      presentation_color: "",
      price_yen: 300000,
      previous_price_yen: null,
      stock_status: "in_stock",
      first_seen_at: "2026-08-20T10:00:00Z",
      last_seen_at: "2026-08-25T10:00:00Z",
      last_activity_at: "2026-08-25T10:00:00Z",
      source_published_at: null,
    },
    ...overrides,
  };
}

test("feed query is chronological, bounded, unpaginated, and canonical", () => {
  const url = new URL(
    "https://example.test/api/feed?q=TAD&feature=dac&limit=100&offset=50&cursor=opaque",
  );
  assert.equal(validateFeedQuery(url), null);
  const query = parseFeedQuery(url);
  assert.equal(query.sort, "newest");
  assert.equal(query.explicitSort, true);
  assert.equal(query.limit, FEED_MAX_PAGE_SIZE);
  assert.equal(query.offset, 0);
  assert.equal(query.cursor, null);
  assert.equal(query.includeTotal, false);
  assert.equal(
    canonicalFeedQueryUrl(url, query).toString(),
    "https://example.test/api/feed?q=TAD&feature=dac&limit=25",
  );
});

test("feed preserves a caller limit below its polling cap", () => {
  const url = new URL("https://example.test/api/feed?limit=10");
  const query = parseFeedQuery(url);
  assert.equal(query.limit, 10);
  assert.equal(canonicalFeedQueryUrl(url, query).search, "?limit=10");
});

test("feed rejects conflicting sort but ignores malformed pagination", () => {
  assert.equal(
    validateFeedQuery(new URL("https://example.test/api/feed?sort=priceAsc")),
    "feed_sort_must_be_newest",
  );
  assert.equal(
    validateFeedQuery(new URL("https://example.test/api/feed?cursor=%00&offset=nope")),
    null,
  );
  assert.equal(
    validateFeedQuery(new URL("https://example.test/api/feed?unknown=x")),
    "parameter_unknown",
  );
});

test("Atom output uses stable ids, observed timestamps, seller links, and escaped text", () => {
  const xml = productSearchAtomFeed(
    [item()],
    new URL("https://example.test/api/feed?q=LUXMAN&limit=25"),
  );
  assert.match(xml, /<id>urn:hifiscout:product:c-42<\/id>/u);
  assert.match(xml, /<updated>2026-08-25T10:00:00\.000Z<\/updated>/u);
  assert.match(xml, /a=1&amp;b=2/u);
  assert.match(xml, /&lt;L-507Z&gt; &quot;中古&quot; &amp; demo/u);
  assert.doesNotMatch(xml, /\u0001/u);
  assert.match(xml, /価格: 300,000円〜320,000円/u);
});

test("feed timestamp is deterministic when nothing changed", () => {
  const canonical = new URL("https://example.test/api/feed?limit=25");
  const first = productSearchAtomFeed([item()], canonical);
  const second = productSearchAtomFeed([item()], canonical);
  assert.equal(first, second);
  assert.match(productSearchAtomFeed([], canonical), /1970-01-01T00:00:00\.000Z/u);
});

test("escapeXml preserves valid Unicode while removing invalid XML controls", () => {
  assert.equal(escapeXml("A😀<&\"'\u0000B"), "A😀&lt;&amp;&quot;&apos;B");
});
