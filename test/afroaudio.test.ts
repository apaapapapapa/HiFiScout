import test from "node:test";
import assert from "node:assert/strict";

import {
  afroAudioAdapter,
  discoverAfroAudioPageUrls,
  parseAfroAudioListing,
} from "../src/crawler/shops/afroaudio.js";
import { initialPageQueue } from "../src/crawler/strategies.js";

const listingHtml = `
<section class="product-list">
  <article>
    <a href="/products/detail/30094">
      NEW 〖Aランク〗Accuphase DP-570 CDデッキ アキュフェーズ
      @60834 60834 ￥650,000 税込 在庫あり
      天板に小さな点キズがあります。 Accuphase DP-570
    </a>
  </article>
  <article>
    <a href="/products/detail/30026">
      NEW 〖Cランク〗Accuphase E-307 プリメインアンプ アキュフェーズ
      @60734 60734 ￥290,000 税込 売約済
    </a>
  </article>
  <article>
    <a href="https://afroaudio.jp/products/detail/29999">
      〖Bランク〗MICRO DD-8 ターンテーブル マイクロ
      @60560 60560 ￥60,000 税込 販売済
    </a>
  </article>
</section>`;

test("Afro Audio parser extracts seller facts and canonical availability", () => {
  const items = parseAfroAudioListing(listingHtml, {
    url: "https://afroaudio.jp/products/list?category_id=1",
    page: 1,
    categoryId: 1,
    rawCategory: "プレーヤー",
  });

  assert.equal(items.length, 3);

  const available = items[0];
  assert.equal(available.sourceId, "30094");
  assert.equal(available.title, "〖Aランク〗Accuphase DP-570 CDデッキ アキュフェーズ");
  assert.equal(available.manufacturer, "Accuphase");
  assert.match(available.model, /DP-570/);
  assert.equal(available.priceYen, 650000);
  assert.equal(available.stockStatus, "in_stock");
  assert.equal(available.rawCategory, "プレーヤー");
  assert.equal(available.conditionText, "Aランク");
  assert.equal(available.sourceUrl, "https://afroaudio.jp/products/detail/30094");
  assert.equal(available.metadata?.productCode, "60834");

  assert.equal(items[1].stockStatus, "sold_out");
  assert.equal(items[2].stockStatus, "sold_out");
});

test("Afro Audio parser de-duplicates links and ignores footer availability labels", () => {
  const html = `
    <div class="item">
      <a href="/products/detail/30123"><img src="/item.jpg" alt=""></a>
      <a href="/products/detail/30123">〖Bランク〗LUXMAN L-509Z プリメインアンプ ラックスマン</a>
      <span>@60999 60999</span><span>￥780,000 税込</span><span>在庫あり</span>
    </div>
    <footer><a href="/products/list?category_id=99">販売済</a></footer>`;

  const items = parseAfroAudioListing(html, { rawCategory: "アンプ" });
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceId, "30123");
  assert.equal(items[0].priceYen, 780000);
  assert.equal(items[0].stockStatus, "in_stock");
});

test("Afro Audio pagination expands the observed last page for the same category", () => {
  const html = `
    <a href="?category_id=19&pageno=2">2</a>
    <a href="/products/list?category_id=19&pageno=5">最後へ</a>
    <a href="/products/list?category_id=3&pageno=99">other category</a>`;

  assert.deepEqual(
    discoverAfroAudioPageUrls(html, {
      url: "https://afroaudio.jp/products/list?category_id=19",
      page: 1,
      categoryId: 19,
      rawCategory: "アンプ",
    }),
    [2, 3, 4, 5].map((page) => ({
      url: `https://afroaudio.jp/products/list?category_id=19&pageno=${page}`,
      page,
      categoryId: 19,
      rawCategory: "アンプ",
    })),
  );
});

test("Afro Audio adapter starts from audio-only top-level categories", () => {
  assert.deepEqual(initialPageQueue(afroAudioAdapter, 40), [
    { url: "https://afroaudio.jp/products/list?category_id=1", page: 1, categoryId: 1, rawCategory: "プレーヤー" },
    { url: "https://afroaudio.jp/products/list?category_id=19", page: 1, categoryId: 19, rawCategory: "アンプ" },
    { url: "https://afroaudio.jp/products/list?category_id=3", page: 1, categoryId: 3, rawCategory: "スピーカー・ヘッドフォン" },
    { url: "https://afroaudio.jp/products/list?category_id=4", page: 1, categoryId: 4, rawCategory: "デジタル機器・コンバーター類" },
    { url: "https://afroaudio.jp/products/list?category_id=5", page: 1, categoryId: 5, rawCategory: "アナログパーツ・フォノイコライザー" },
    { url: "https://afroaudio.jp/products/list?category_id=6", page: 1, categoryId: 6, rawCategory: "ケーブル類" },
    { url: "https://afroaudio.jp/products/list?category_id=7", page: 1, categoryId: 7, rawCategory: "電源" },
    { url: "https://afroaudio.jp/products/list?category_id=8", page: 1, categoryId: 8, rawCategory: "ラック・その他" },
    { url: "https://afroaudio.jp/products/list?category_id=15", page: 1, categoryId: 15, rawCategory: "真空管" },
  ]);
  assert.equal(afroAudioAdapter.discovery.coverage, "complete");
});
