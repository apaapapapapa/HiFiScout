import test from "node:test";
import assert from "node:assert/strict";
import { ippinkanAdapter } from "../src/crawler/shops/ippinkan.js";

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
