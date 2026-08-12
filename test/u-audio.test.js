import test from "node:test";
import assert from "node:assert/strict";
import {
  parseUAudioListing,
  parseUAudioResultCount,
  uAudioAdapter,
} from "../src/crawler/shops/u-audio.js";

const html = `
<h1>中古スピーカー</h1><p>全 41 件</p>
<ul>
<li><a href="/view/item/000000009659?category_page_id=ct4"><img src="x.jpg"></a>
<a href="/view/item/000000009659?category_page_id=ct4">802D4W(サテン・ホワイト) / B&amp;W ※商談中</a>
商品コード 12725 定価（税込） ￥5,302,000 販売価格（税込） ￥2,980,000 カートに入れる</li>
<li>SOLD OUT <a href="/view/item/000000009600?category_page_id=ct4">800 Diamond PB / B&amp;W 売約済</a>
商品コード 12776 定価（税込） ￥3,960,000 販売価格（税込） － 売り切れ</li>
<li><a href="/view/item/000000009528?category_page_id=ct18">Kaluga / Mola Mola メーカーデモ機処分１ペア</a>
商品コード 定価（税込） ￥2,980,000 販売価格（税込） お問い合わせください お問い合わせ</li>
</ul>`;

test("U-AUDIO parser handles stock, inquiry prices, seller notes, and stable item ids", () => {
  assert.equal(parseUAudioResultCount(html), 41);
  const items = parseUAudioListing(html, { rawCategory: "中古スピーカー" });
  assert.equal(items.length, 3);

  assert.equal(items[0].sourceId, "000000009659");
  assert.equal(items[0].sourceUrl, "https://www.u-audio.com/view/item/000000009659");
  assert.equal(items[0].manufacturer, "B&W");
  assert.equal(items[0].model, "802D4W(サテン・ホワイト)");
  assert.equal(items[0].priceYen, 2980000);
  assert.equal(items[0].stockStatus, "in_stock");
  assert.match(items[0].conditionText, /商談中/);

  assert.equal(items[1].stockStatus, "sold_out");
  assert.equal(items[1].priceYen, null);
  assert.equal(items[1].metadata.productCode, "12776");

  assert.equal(items[2].manufacturer, "Mola Mola");
  assert.equal(items[2].priceYen, null);
  assert.equal(items[2].stockStatus, "in_stock");
});

test("U-AUDIO outlet entries are marked and treated as available unless sold out", () => {
  const [item] = parseUAudioListing(html, { rawCategory: "アウトレット", outlet: true });
  assert.equal(item.stockStatus, "in_stock");
  assert.equal(item.metadata.outlet, true);
  assert.match(item.conditionText, /アウトレット/);
});

test("U-AUDIO pagination crawls all outlet pages before used categories", () => {
  const [bootstrap] = [...uAudioAdapter.pageUrls()];
  assert.equal(bootstrap.url, "https://www.u-audio.com/view/category/ct18");
  assert.equal(bootstrap.bootstrap, true);

  const discovered = uAudioAdapter.discoverPageUrls("<p>全 49 件</p>", bootstrap);
  assert.equal(discovered[0].url, "https://www.u-audio.com/view/category/ct18?page=2");
  assert.equal(discovered[1].url, "https://www.u-audio.com/view/category/ct4");
  assert.equal(discovered.at(-1).url, "https://www.u-audio.com/view/category/ct10");
  assert.equal(
    discovered.some((page) => page.categoryCode === "ct11"),
    false,
  );

  const accessory = discovered.find((page) => page.categoryCode === "ct10");
  assert.deepEqual(uAudioAdapter.discoverPageUrls("<p>全 48 件</p>", accessory), [
    {
      url: "https://www.u-audio.com/view/category/ct10?page=2",
      page: 2,
      categoryCode: "ct10",
      rawCategory: "中古アクセサリー",
      outlet: false,
    },
  ]);
});
