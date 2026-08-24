import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { ippinkanAdapter } from "../src/crawler/shops/ippinkan.js";
import { discoverPages, initialPageQueue } from "../src/crawler/strategies.js";

const PAGE_URL = "https://ippinkan.jp/shopbrand/U100000/page14/order/";
const DETAIL_URL = "/shopdetail/000000027581/U100000/page14/order/";

test("Ippinkan treats a priced listing without a sold-out marker as in stock", () => {
  const html = `<div class="item">
    <a href="${DETAIL_URL}">LUXMAN - D-10X《JP-u》</a>
    <span>780,000円（税込）</span>
  </div>`;

  const [item] = ippinkanAdapter.parse(html, PAGE_URL);

  assert.equal(item.stockStatus, "in_stock");
  assert.equal(item.sourceUrl, `https://ippinkan.jp${DETAIL_URL}`);
});

test("Ippinkan keeps explicit sold-out markers as sold out", () => {
  const html = `<div class="item">
    <a href="${DETAIL_URL}">LUXMAN - D-10X《JP-u》</a>
    <span>780,000円（税込）</span>
    <span>品切れ</span>
  </div>`;

  const [item] = ippinkanAdapter.parse(html, PAGE_URL);

  assert.equal(item.stockStatus, "sold_out");
});

test("Ippinkan follows only pagination links exposed by the storefront", () => {
  assert.deepEqual(initialPageQueue(ippinkanAdapter, 40), [
    "https://ippinkan.jp/shopbrand/U100000/",
  ]);

  const html = `
    <a href="/shopbrand/U100000/page2/order/">2</a>
    <a href="https://ippinkan.jp/shopbrand/U100000/page10/order/?ignored=1">10</a>
    <a href="/shopdetail/000000027581/U100000/page1/order/">product</a>
    <a href="https://example.com/shopbrand/U100000/page3/order/">external</a>
  `;

  assert.deepEqual(discoverPages(ippinkanAdapter, html, "https://ippinkan.jp/shopbrand/U100000/"), [
    "https://ippinkan.jp/shopbrand/U100000/page2/order/",
    "https://ippinkan.jp/shopbrand/U100000/page10/order/",
  ]);
});
