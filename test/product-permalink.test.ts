import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { ProductSearchDetailResponse } from "../src/api/contracts.js";
import {
  isProductPermalinkRoute,
  productKeyFromPermalinkPath,
  productPermalinkPath,
} from "../src/api/product-permalink.js";
import {
  productPermalinkNotFoundResponse,
  renderProductPermalinkHtml,
} from "../src/http/product-permalink.js";
import { sanitizedCatalogUrl } from "../frontend/catalog-url-sanitizer.js";

test("product permalink paths accept only exact namespaced keys", () => {
  assert.equal(productKeyFromPermalinkPath("/p/c-1"), "c-1");
  assert.equal(productKeyFromPermalinkPath("/p/l-999"), "l-999");
  assert.equal(productPermalinkPath("c-42"), "/p/c-42");
  assert.equal(productPermalinkPath("42"), null);
  assert.equal(productKeyFromPermalinkPath("/p/c-0"), null);
  assert.equal(productKeyFromPermalinkPath("/p/c-1/extra"), null);
  assert.equal(productKeyFromPermalinkPath("/p/C-1"), null);
  assert.equal(isProductPermalinkRoute("/p"), true);
  assert.equal(isProductPermalinkRoute("/p/not-a-key"), true);
  assert.equal(isProductPermalinkRoute("/products/c-1"), false);
});

test("catalog sanitizer preserves a valid product path and removes hostile query state", () => {
  assert.equal(
    sanitizedCatalogUrl("/p/c-42", "?q=LUXMAN&limit=999", "#offers"),
    "/p/c-42?q=LUXMAN#offers",
  );
  assert.equal(sanitizedCatalogUrl("/p/c-42", "?q=LUXMAN", ""), null);
  assert.equal(sanitizedCatalogUrl("/p/not-a-key", "?q=LUXMAN", ""), "/?q=LUXMAN");
});

const DETAIL = {
  product: {
    key: "c-1",
    manufacturer: "LUX&MAN",
    model: 'D<10X>"',
    category: "CD & SACD",
    presentation_colors: ["Black & Silver"],
    offer_count: 2,
    in_stock_offer_count: 1,
    lowest_price_yen: 660000,
    highest_price_yen: 712000,
  },
  offers: [
    {
      shop_key: "unknown-shop",
      source_url: "https://example.com/item?x=1&y=2",
      title: "D-10X <展示品>",
      condition_text: '美品 "A"',
      presentation_color: "Silver",
      price_yen: 660000,
      stock_status: "in_stock",
    },
    {
      shop_key: "another-shop",
      source_url: "javascript:alert(1)",
      title: "D-10X sold",
      condition_text: "",
      presentation_color: "",
      price_yen: 712000,
      stock_status: "sold_out",
    },
  ],
} as unknown as ProductSearchDetailResponse;

test("SSR product HTML exposes factual detail with canonical OGP and noindex", () => {
  const html = renderProductPermalinkHtml(DETAIL, "https://hifiscout.example");

  assert.match(html, /<meta name="robots" content="noindex,follow">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/hifiscout\.example\/p\/c-1">/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /property="og:description"/);
  assert.match(html, /name="twitter:card" content="summary"/);
  assert.match(html, /LUX&amp;MAN/);
  assert.match(html, /D&lt;10X&gt;&quot;/);
  assert.match(html, /D-10X &lt;展示品&gt;/);
  assert.match(html, /660,000円/);
  assert.match(html, /売り切れ/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.doesNotMatch(html, /<img/i);
});

test("unknown permalink response is a usable no-store 404 without the SPA shell", async () => {
  const response = productPermalinkNotFoundResponse();
  const html = await response.text();

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(html, /商品が見つかりません/);
  assert.match(html, /href="\/"/);
  assert.doesNotMatch(html, /src="\/app\.js"/);
});
