import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverRewirePageUrls,
  parseRewireListing,
  rewireAdapter,
} from "../src/crawler/shops/rewire.js";
import { initialPageQueue } from "../src/crawler/strategies.js";

const listingHtml = `
<section class="used-products">
  <article>
    <a href="/webshop/2026/08/03/paradigm-founder-120h/">
      Paradigm Founder 120H #R10045 ¥778,800(税込) スピーカー
    </a>
  </article>
  <article>
    <a href="https://rewire.co.jp/webshop/2026/07/25/tannoy-arden-legacy/">
      Sold Out 〖美品〗TANNOY ARDEN LEGACY タンノイ アーデン 2017-2026年モデル ＃R09973
      ¥638,300(税込)Sold Out スピーカー
    </a>
  </article>
  <article>
    <a href="/webshop/2026/08/01/storm-audio-isp-16-analog-mk3/">
      STORM AUDIO ISP 16 ANALOG MK3 ストームオーディオ ハイエンドAVプロセッサー /
      ナスペック メンテナンス済品 ¥1,800,000(税込) アンプ
    </a>
  </article>
</section>
<aside>
  <a href="/webshop/2025/01/01/old-recommended-item/">Old recommended item (R08000)</a>
</aside>`;

test("REWIRE parser extracts listing facts and availability", () => {
  const items = parseRewireListing(listingHtml);
  assert.equal(items.length, 3);

  const available = items[0];
  assert.equal(available.sourceId, "R10045");
  assert.equal(
    available.sourceUrl,
    "https://rewire.co.jp/webshop/2026/08/03/paradigm-founder-120h/",
  );
  assert.equal(available.title, "Paradigm Founder 120H");
  assert.equal(available.rawManufacturer, "Paradigm");
  assert.equal(available.manufacturer, "Paradigm");
  assert.match(available.model, /Founder 120H/);
  assert.equal(available.rawCategory, "スピーカー");
  assert.equal(available.priceYen, 778800);
  assert.equal(available.stockStatus, "in_stock");
  assert.equal(available.conditionText, "");
  assert.equal(available.metadata?.productCode, "R10045");

  const sold = items[1];
  assert.equal(sold.sourceId, "R09973");
  assert.equal(sold.title, "TANNOY ARDEN LEGACY タンノイ アーデン 2017-2026年モデル");
  assert.equal(sold.conditionText, "美品");
  assert.equal(sold.priceYen, 638300);
  assert.equal(sold.stockStatus, "sold_out");
  assert.equal(sold.rawCategory, "スピーカー");

  const withoutSellerCode = items[2];
  assert.equal(withoutSellerCode.sourceId, "2026-08-01-storm-audio-isp-16-analog-mk3");
  assert.equal(withoutSellerCode.priceYen, 1800000);
  assert.equal(withoutSellerCode.stockStatus, "in_stock");
  assert.equal(withoutSellerCode.rawCategory, "アンプ");
  assert.deepEqual(withoutSellerCode.metadata, {});
});

test("REWIRE parser ignores non-listing product links without a price", () => {
  const items = parseRewireListing(`
    <a href="/webshop/2026/08/03/paradigm-founder-120h/">Paradigm Founder 120H (R10045)</a>
    <a href="/webshop/2026/08/03/paradigm-founder-120h/">
      Paradigm Founder 120H #R10045 ¥778,800(税込) スピーカー
    </a>`);

  assert.equal(items.length, 1);
  assert.equal(items[0].sourceId, "R10045");
});

test("REWIRE pagination expands through the observed last page", () => {
  const html = `
    <a href="/webshop/category/item/usedvintage/page/2/">2</a>
    <a href="https://rewire.co.jp/webshop/category/item/usedvintage/page/3/">3</a>
    <a href="/webshop/category/item/usedvintage/page/13/">Last</a>
    <a href="/webshop/category/item/newitem/page/99/">other category</a>`;

  const pages = discoverRewirePageUrls(html, {
    url: "https://rewire.co.jp/webshop/category/item/usedvintage/",
    page: 1,
  });

  assert.equal(pages.length, 12);
  assert.deepEqual(pages[0], {
    url: "https://rewire.co.jp/webshop/category/item/usedvintage/page/2/",
    page: 2,
  });
  assert.deepEqual(pages.at(-1), {
    url: "https://rewire.co.jp/webshop/category/item/usedvintage/page/13/",
    page: 13,
  });
});

test("REWIRE adapter starts from the complete used and vintage index", () => {
  assert.deepEqual(initialPageQueue(rewireAdapter, 30), [
    {
      url: "https://rewire.co.jp/webshop/category/item/usedvintage/",
      page: 1,
    },
  ]);
  assert.equal(rewireAdapter.discovery.coverage, "complete");
});
