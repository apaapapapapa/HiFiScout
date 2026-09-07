import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  MAX_OFFSET,
  canonicalProductQueryUrl,
  parseProductQuery,
  usesRelevanceOrder,
  validateProductQuery,
} from "../src/api/product-query.js";

function url(search: string): URL {
  return new URL(`https://example.test/api/products${search}`);
}

test("product query validation rejects oversized and malformed inputs", () => {
  assert.equal(validateProductQuery(url(`?q=${"x".repeat(101)}`)), "q_too_long");
  assert.equal(validateProductQuery(url("?limit=-1")), "limit_invalid");
  assert.equal(validateProductQuery(url("?sort=random")), "sort_invalid");
  assert.equal(validateProductQuery(url("?sort=%20updated")), "sort_invalid");
  assert.equal(validateProductQuery(url("?q=TAD&limit=50&sort=newest")), null);
  assert.equal(validateProductQuery(url("?sort=updated")), null);
  assert.equal(validateProductQuery(url("?sort=oldest")), null);
});

test("unknown and repeated singleton parameters cannot become cache busters", () => {
  assert.equal(validateProductQuery(url("?q=TAD&nonce=1")), "parameter_unknown");
  assert.equal(validateProductQuery(url("?q=TAD&q=ME1")), "q_repeated");
  assert.equal(validateProductQuery(url("?feature=dac&feature=network_playback")), null);
});

test("repeated shops and manufacturers use bounded literal values and canonical set ordering", () => {
  const input = url(
    "?shop=b&shop=a&shop=b&manufacturer=LUXMAN&manufacturer=Acme%2C+Inc.&manufacturer=%20LUXMAN%20",
  );
  assert.equal(validateProductQuery(input), null);
  const query = parseProductQuery(input);
  assert.deepEqual(query.shop, ["a", "b"]);
  assert.deepEqual(query.manufacturer, ["Acme, Inc.", "LUXMAN"]);
  const canonical = canonicalProductQueryUrl(input, query);
  assert.deepEqual(canonical.searchParams.getAll("shop"), ["a", "b"]);
  assert.deepEqual(canonical.searchParams.getAll("manufacturer"), ["Acme, Inc.", "LUXMAN"]);
  assert.equal(
    canonicalProductQueryUrl(canonical, parseProductQuery(canonical)).href,
    canonical.href,
  );
  for (const field of ["shop", "manufacturer"]) {
    assert.equal(
      validateProductQuery(
        url("?" + Array.from({ length: 21 }, (_, i) => `${field}=${i}`).join("&")),
      ),
      `${field}_too_many`,
    );
  }
  assert.equal(validateProductQuery(url(`?shop=a&shop=${"x".repeat(81)}`)), "shop_too_long");
  assert.deepEqual(parseProductQuery(url("?shop=a&manufacturer=LUXMAN")).shop, ["a"]);
});

test("boolean product filters reject unsupported values", () => {
  assert.equal(validateProductQuery(url("?newOnly=1")), "newOnly_invalid");
  assert.equal(validateProductQuery(url("?priceDropped=yes")), "priceDropped_invalid");
});

test("pagination query validation bounds offset and total-count flags", () => {
  assert.equal(validateProductQuery(url("?offset=-1")), "offset_invalid");
  assert.equal(validateProductQuery(url("?includeTotal=yes")), "includeTotal_invalid");
  assert.equal(validateProductQuery(url(`?offset=${MAX_OFFSET + 1}`)), "offset_too_large");
  assert.equal(validateProductQuery(url(`?offset=${MAX_OFFSET}&includeTotal=true`)), null);
});

test("feature parameters are length-checked before they are resolved", () => {
  assert.equal(validateProductQuery(url(`?feature=${"d".repeat(201)}`)), "feature_too_long");
  assert.equal(validateProductQuery(url("?feature=magic")), "feature_invalid");
  assert.equal(validateProductQuery(url("?feature=dac,network_playback")), null);
  assert.equal(validateProductQuery(url("?feature=dac,%20network_playback")), null);
});

test("typed facet parameters validate, parse, and de-duplicate", () => {
  assert.equal(validateProductQuery(url("?facet=connectivity:wireless")), null);
  assert.equal(validateProductQuery(url("?facet=unknown:value")), "invalid_facet");
  assert.equal(validateProductQuery(url("?facet=connectivity:unknown")), "invalid_facet");
  assert.equal(validateProductQuery(url("?facet=connectivity")), "invalid_facet");

  assert.deepEqual(
    parseProductQuery(
      url("?facet=connectivity:wireless,protocol:bluetooth&facet=connectivity:wireless"),
    ).facets,
    [
      { facetId: "connectivity", value: "wireless" },
      { facetId: "protocol", value: "bluetooth" },
    ],
  );
});

test("an absent query parses to the default page of newest listings", () => {
  const query = parseProductQuery(url(""));

  assert.deepEqual(query, {
    q: "",
    shop: [],
    manufacturer: [],
    category: "",
    features: [],
    facets: [],
    offerFacts: [],
    inStock: false,
    newOnly: false,
    priceDropped: false,
    minPrice: null,
    maxPrice: null,
    sort: "newest",
    explicitSort: false,
    cursor: null,
    limit: 50,
    offset: 0,
    includeTotal: false,
  });
});

test("page size and defensive offset parsing remain bounded", () => {
  assert.equal(parseProductQuery(url("?limit=1000")).limit, 100);
  assert.equal(parseProductQuery(url("?limit=0")).limit, 1);
  assert.equal(parseProductQuery(url("?limit=abc")).limit, 50);
  assert.equal(parseProductQuery(url("?offset=abc")).offset, 0);
  assert.equal(parseProductQuery(url(`?offset=${MAX_OFFSET + 500}`)).offset, MAX_OFFSET);
  assert.equal(parseProductQuery(url("?minPrice=abc")).minPrice, null);
  assert.equal(parseProductQuery(url("?minPrice=100000")).minPrice, 100000);
});

test("offer facts validate, deduplicate and canonicalize for search and subscriptions", () => {
  assert.equal(validateProductQuery(url("?offer=remote_control,shop_warranty")), null);
  assert.equal(validateProductQuery(url("?offer=remote_control:absent")), "offer_invalid");
  assert.equal(validateProductQuery(url("?offer=imaginary")), "offer_invalid");
  const input = url("?offer=shop_warranty&offer=remote_control,shop_warranty");
  const parsed = parseProductQuery(input);
  assert.deepEqual(parsed.offerFacts, ["shop_warranty", "remote_control"]);
  assert.deepEqual(canonicalProductQueryUrl(input, parsed).searchParams.getAll("offer"), [
    "remote_control",
    "shop_warranty",
  ]);
});

test("free-text values are trimmed and repeated feature parameters are de-duplicated", () => {
  const query = parseProductQuery(url("?q=%20TAD%20&feature=dac,%20dac&feature=network_playback"));

  assert.equal(query.q, "TAD");
  assert.deepEqual(query.features, ["dac", "network_playback"]);
});

test("canonical query URLs collapse semantically equivalent cache keys", () => {
  const first = url("?q=%20TAD%20&feature=network_playback&feature=dac&limit=050&inStock=false");
  const second = url("?limit=50&feature=dac,network_playback&q=TAD");
  const firstCanonical = canonicalProductQueryUrl(first, parseProductQuery(first));
  const secondCanonical = canonicalProductQueryUrl(second, parseProductQuery(second));

  assert.equal(firstCanonical.toString(), secondCanonical.toString());
  assert.equal(firstCanonical.search, "?q=TAD&feature=dac&feature=network_playback&limit=50");
});

test("canonical query URLs sort typed facet selections", () => {
  const request = url("?facet=protocol:bluetooth&facet=connectivity:wireless");
  const canonical = canonicalProductQueryUrl(request, parseProductQuery(request));
  assert.equal(
    canonical.search,
    "?facet=connectivity%3Awireless&facet=protocol%3Abluetooth&limit=50",
  );
});

test("an unknown sort falls back to newest without reporting an explicit sort choice", () => {
  const query = parseProductQuery(url("?sort=random"));

  assert.equal(query.sort, "newest");
  assert.equal(query.explicitSort, true);
});

test("relevance ordering applies only to an unsorted search", () => {
  assert.equal(usesRelevanceOrder(parseProductQuery(url("?q=TAD"))), true);
  assert.equal(usesRelevanceOrder(parseProductQuery(url("?q=TAD&sort=newest"))), false);
  assert.equal(usesRelevanceOrder(parseProductQuery(url("?sort=newest"))), false);
  assert.equal(usesRelevanceOrder(parseProductQuery(url(""))), false);
});
