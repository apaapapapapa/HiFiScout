import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverOsakayaPageUrls,
  osakayaAdapter,
  parseOsakayaListing,
} from "../src/crawler/shops/osakaya.js";
import { initialPageQueue } from "../src/crawler/strategies.js";

const usedPage = {
  url: "https://osakaya.com/store/items/?search%5Bc_pt%5D%5B%5D=2",
  page: 1,
  conditionCode: "2" as const,
  conditionText: "中古品" as const,
};

const specialPage = {
  url: "https://osakaya.com/store/items/?search%5Bc_pt%5D%5B%5D=3",
  page: 1,
  conditionCode: "3" as const,
  conditionText: "特価品" as const,
};

test("CAVIN Osaka-ya parser keeps the selling price instead of MSRP", () => {
  const html = `
    <article>
      <a href="/store/items/pre-amp/2091/"><img src="/image.jpg" alt=""></a>
      <a href="/store/items/pre-amp/2091/">
        <span>LUXMAN ラックスマン</span>
        <span>CL-38u</span>
        <span>真空管プリアンプ</span>
        <span>中古品</span>
        <span>標準価格: ￥352,000</span>
        <strong>￥248,000 税込</strong>
      </a>
    </article>`;

  const items = parseOsakayaListing(html, usedPage);
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceId, "2091");
  assert.equal(items[0].sourceUrl, "https://osakaya.com/store/items/pre-amp/2091/");
  assert.equal(items[0].title, "LUXMAN ラックスマン CL-38u 真空管プリアンプ");
  assert.equal(items[0].manufacturer, "LUXMAN");
  assert.match(items[0].model, /^CL-38u/u);
  assert.equal(items[0].rawCategory, "pre-amp");
  assert.equal(items[0].category, "プリアンプ");
  assert.equal(items[0].conditionText, "中古品");
  assert.equal(items[0].priceYen, 248000);
  assert.equal(items[0].stockStatus, "in_stock");
  assert.deepEqual(items[0].metadata, { categorySlug: "pre-amp", conditionCode: "2" });
});

test("CAVIN Osaka-ya parser handles special-price cards and sold-out evidence", () => {
  const html = `
    <a href="/store/items/pre-main-amp/3001/">
      ESOTERIC エソテリック F-02 展示品特価プリメインアンプ
      特価品 30%OFF 標準価格: ￥1,870,000 ￥1,309,000税込 売り切れ
    </a>`;

  const [item] = parseOsakayaListing(html, specialPage);
  assert.ok(item);
  assert.equal(item.sourceId, "3001");
  assert.equal(item.conditionText, "特価品");
  assert.equal(item.priceYen, 1309000);
  assert.equal(item.stockStatus, "sold_out");
  assert.equal(item.category, "プリメインアンプ");
});

test("CAVIN Osaka-ya pagination follows observed links only for the selected condition", () => {
  const html = `
    <a href="?search%5Bc_pt%5D%5B%5D=2&page=2">2</a>
    <a href="?search%5Bc_pt%5D%5B%5D=2&page=3">»</a>
    <a href="?search%5Bc_pt%5D%5B%5D=3&page=99">99</a>
    <a href="/store/items/pre-amp/2091/">LUXMAN CL-38u 中古品 ￥248,000税込</a>`;

  assert.deepEqual(discoverOsakayaPageUrls(html, usedPage), [
    {
      ...usedPage,
      url: "https://osakaya.com/store/items/?search%5Bc_pt%5D%5B%5D=2&page=2",
      page: 2,
    },
    {
      ...usedPage,
      url: "https://osakaya.com/store/items/?search%5Bc_pt%5D%5B%5D=2&page=3",
      page: 3,
    },
  ]);
});

test("CAVIN Osaka-ya pagination falls back to result count when page links are scripted", () => {
  const html = `
    <div>対象商品数：4</div>
    <a href="/store/items/pre-amp/1001/">LUXMAN C-10 プリアンプ 中古品 ￥100,000税込</a>
    <a href="/store/items/power-amp/1002/">LUXMAN M-10 パワーアンプ 中古品 ￥200,000税込</a>
    <a href="javascript:void(0)">2</a>`;

  assert.deepEqual(discoverOsakayaPageUrls(html, usedPage), [
    {
      ...usedPage,
      url: "https://osakaya.com/store/items/?search%5Bc_pt%5D%5B%5D=2&page=2",
      page: 2,
    },
  ]);
});

test("CAVIN Osaka-ya adapter starts from only the requested used and special-price feeds", () => {
  assert.deepEqual(initialPageQueue(osakayaAdapter, 20), [usedPage, specialPage]);
  assert.equal(osakayaAdapter.discovery.coverage, "complete");
});
