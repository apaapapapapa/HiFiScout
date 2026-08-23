import { test } from "vitest";
import assert from "node:assert/strict";
import {
  discoverSoundPitDetails,
  parseSoundPitDetail,
  soundPitAdapter,
  type SoundPitPage,
} from "../src/crawler/shops/soundpit.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { discoverPages, initialPageQueue } from "../src/crawler/strategies.js";

const listingHtml = `
<div class="used-item">
  <p>GamuT</p>
  <p>Hi-Fi Lobster Chair</p>
  <p>リスニングチェア</p>
  <p>売約済</p>
  <a href="pg555.html">詳細はこちら</a>
</div>
<div class="used-item">
  <p>MSB TECHNOLOGY</p>
  <p>Reference DAC</p>
  <p>DAC</p>
  <a href="/pg554.html">詳細はこちら</a>
</div>
<div class="used-item">
  <p>External</p>
  <p>Ignored</p>
  <p>DAC</p>
  <a href="https://example.com/pg999.html">詳細はこちら</a>
</div>`;

test("Sound Pit discovery follows only detail links and carries listing availability", () => {
  const pages = discoverSoundPitDetails(listingHtml);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0], {
    url: "https://sound-pit.jp/pg555.html",
    kind: "detail",
    soldOut: true,
    fallbackManufacturer: "GamuT",
    fallbackModel: "Hi-Fi Lobster Chair",
    fallbackCategory: "リスニングチェア",
  });
  assert.deepEqual(pages[1], {
    url: "https://sound-pit.jp/pg554.html",
    kind: "detail",
    soldOut: false,
    fallbackManufacturer: "MSB TECHNOLOGY",
    fallbackModel: "Reference DAC",
    fallbackCategory: "DAC",
  });
});

test("Sound Pit detail parser extracts factual price and product fields", () => {
  const html = `
  <h3>Used Audio 中古商品</h3>
  <h2>Burmester</h2>
  <h2>911 MK3</h2>
  <p>ブルメスター「911 MK3」</p>
  <p>ステレオパワーアンプ 中古品</p>
  <p>¥1,793,000-(税込)</p>
  <p>目立つような傷や汚れはございません。</p>
  <a href="/pg102.html">Used Power amp/一覧へ戻る</a>
  <h2>ハイエンド &amp; ヴィンテージ オーディオ専門店 サウンドピット</h2>`;
  const page: SoundPitPage = {
    url: "https://sound-pit.jp/pg530.html",
    kind: "detail",
    soldOut: false,
  };

  const [item] = parseSoundPitDetail(html, page);
  assert.ok(item);
  assert.equal(item.sourceId, "530");
  assert.equal(item.sourceUrl, "https://sound-pit.jp/pg530.html");
  assert.equal(item.manufacturer, "Burmester");
  assert.equal(item.rawManufacturer, "Burmester");
  assert.equal(item.model, "911 MK3");
  assert.equal(item.title, "911 MK3");
  assert.equal(item.rawCategory, "ステレオパワーアンプ");
  assert.equal(item.category, "パワーアンプ");
  assert.equal(item.priceYen, 1793000);
  assert.equal(item.stockStatus, "in_stock");
  assert.match(item.conditionText, /中古品/u);
  assert.deepEqual(item.metadata, { soundPitCategory: "Power amp" });
});

test("Sound Pit detail parser preserves ASK and sold-out semantics", () => {
  const askHtml = `
  <h2>MSB TECHNOLOGY</h2>
  <h2>Reference DAC (Femto 33)</h2>
  <p>MSB TECHNOLOGYのD/Aコンバーター「Reference DAC」</p>
  <p>価格 ¥ASK-</p>
  <a href="/pg103.html">CD/DAC /一覧へ戻る</a>`;
  const [ask] = parseSoundPitDetail(askHtml, {
    url: "https://sound-pit.jp/pg554.html",
    kind: "detail",
    soldOut: false,
  });
  assert.ok(ask);
  assert.equal(ask.priceYen, null);
  assert.equal(ask.stockStatus, "in_stock");
  assert.equal(ask.rawCategory, "D/Aコンバーター");
  assert.equal(ask.category, "DAC");

  const soldHtml = `
  <h2>Bergmann</h2>
  <h2>Galder/Odin</h2>
  <p>ターンテーブル/トーンアーム 中古品</p>
  <p>¥2,000,000-(税込)</p>
  <a href="/pg104.html">Analog/一覧へ戻る</a>`;
  const [sold] = parseSoundPitDetail(soldHtml, {
    url: "https://sound-pit.jp/pg551.html",
    kind: "detail",
    soldOut: true,
  });
  assert.ok(sold);
  assert.equal(sold.priceYen, null);
  assert.equal(sold.stockStatus, "sold_out");
  assert.match(sold.conditionText, /売約済/u);
});

test("Sound Pit adapter is a partial latest-arrivals feed registered for hourly crawling", () => {
  const indexPage: SoundPitPage = { url: "https://sound-pit.jp/pg98.html", kind: "index" };
  assert.deepEqual(initialPageQueue(soundPitAdapter, 50), [indexPage]);
  assert.deepEqual(soundPitAdapter.parse(listingHtml, indexPage), []);
  assert.equal(soundPitAdapter.discovery.coverage, "partial");
  assert.deepEqual(
    discoverPages(soundPitAdapter, listingHtml, indexPage),
    discoverSoundPitDetails(listingHtml),
  );

  const plugin = getShopPlugin("soundpit");
  assert.ok(plugin);
  assert.equal(plugin.definition.defaultIntervalMinutes, 60);
  assert.equal(plugin.definition.defaultMaxPages, 50);
  assert.equal(plugin.definition.envPrefix, "SOUNDPIT");
});
