import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
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
  assert.equal(available.model, "Founder 120H");
  assert.equal(available.rawCategory, "スピーカー");
  assert.equal(available.priceYen, 778800);
  assert.equal(available.stockStatus, "in_stock");
  assert.equal(available.conditionText, "");
  assert.equal(available.metadata?.productCode, "R10045");

  const sold = items[1];
  assert.equal(sold.sourceId, "R09973");
  assert.equal(sold.title, "TANNOY ARDEN LEGACY タンノイ アーデン 2017-2026年モデル");
  assert.equal(sold.model, "ARDEN LEGACY");
  assert.equal(sold.conditionText, "美品");
  assert.equal(sold.priceYen, 638300);
  assert.equal(sold.stockStatus, "sold_out");
  assert.equal(sold.rawCategory, "スピーカー");

  const withoutSellerCode = items[2];
  assert.equal(withoutSellerCode.sourceId, "2026-08-01-storm-audio-isp-16-analog-mk3");
  assert.equal(withoutSellerCode.model, "AUDIO ISP 16 ANALOG MK3");
  assert.equal(withoutSellerCode.priceYen, 1800000);
  assert.equal(withoutSellerCode.stockStatus, "in_stock");
  assert.equal(withoutSellerCode.rawCategory, "アンプ");
  assert.deepEqual(withoutSellerCode.metadata, {});
});

test("REWIRE extracts concise card models while preserving complete seller titles", () => {
  const items = parseRewireListing(`
    <a href="/webshop/2026/08/22/accuphase-e-650/">
      Accuphase E-650 アキュフェーズ プリメインアンプ 3パラプッシュ純A級 30W/8Ω MCS+回路 【正規保証2028】
      #R10120 ¥748,300(税込) アンプ
    </a>
    <a href="/webshop/2024/10/11/audionics_of_oregon_ba-150/">
      AUDIONICS of Oregon BA-150 オーディオニクス ステレオパワーアンプ 150W×2
      @R09203 ¥330,000(税込) アンプ
    </a>
    <a href="/webshop/2025/01/24/marantz_model9/">
      Marantz Model 9 original Pair / Marantz USA #9 マランツ パワーアンプペア
      ¥1,699,800(税込) アンプ
    </a>`);

  assert.equal(items.length, 3);

  assert.equal(items[0].model, "E-650");
  assert.match(items[0].title, /プリメインアンプ/u);
  assert.equal(normalizeCatalogProduct(items[0]).model, "E-650");

  assert.equal(items[1].model, "BA-150");
  assert.match(items[1].title, /150W×2/u);
  assert.equal(normalizeCatalogProduct(items[1]).model, "BA-150");

  assert.equal(items[2].model, "Model 9");
  assert.match(items[2].title, /original Pair/u);
  assert.equal(normalizeCatalogProduct(items[2]).model, "Model 9");
});

test("REWIRE parser decodes numeric entities and classifies known floorstanding speakers", () => {
  const items = parseRewireListing(`
    <article>
      <a href="/webshop/2025/03/04/tannoy_rectangular_grf_15/">
        TANNOY Rectangular GRF 15&#8243;Monitor Red / Monitor Red 15インチ タンノイ スピーカー
        #R09254 ¥1,650,000(税込) スピーカー
      </a>
    </article>
    <article>
      <a href="/webshop/2025/09/04/mcintosh_xrt22/">
        〖整備済〗McIntosh XRT22 + MQ107 マッキントッシュ スピーカーシステム〖最強の音場再現力〗
        @R09442 ¥778,900(税込) McIntosh
      </a>
    </article>`);

  assert.equal(items.length, 2);

  const tannoy = items[0];
  assert.match(tannoy.title, /15″Monitor Red/u);
  assert.doesNotMatch(tannoy.title, /&#8243;/u);
  // splitKnownManufacturerModel normalizes the extracted model with NFKC.
  assert.equal(tannoy.model, "Rectangular GRF 15′′Monitor Red");
  assert.equal(tannoy.rawCategory, "フロア型");
  assert.equal(tannoy.metadata?.rewireSellerCategory, "スピーカー");
  const normalizedTannoy = normalizeCatalogProduct(tannoy);
  assert.equal(normalizedTannoy.primaryCategoryId, "speaker_floorstanding");
  // The shared model resolver removes the finish color so color variants converge on one model.
  assert.equal(normalizedTannoy.model, "Rectangular GRF 15′′Monitor");

  const mcintosh = items[1];
  assert.equal(mcintosh.sourceId, "R09442");
  assert.equal(mcintosh.conditionText, "整備済");
  assert.equal(mcintosh.model, "XRT22 + MQ107");
  assert.equal(mcintosh.rawCategory, "フロア型");
  assert.equal(mcintosh.metadata?.rewireSellerCategory, "McIntosh");
  const normalizedMcIntosh = normalizeCatalogProduct(mcintosh);
  assert.equal(normalizedMcIntosh.primaryCategoryId, "speaker_floorstanding");
  assert.equal(normalizedMcIntosh.model, "XRT22 + MQ107");
});

test("REWIRE does not force unrelated seller buckets into a floorstanding leaf", () => {
  const items = parseRewireListing(`
    <a href="/webshop/2026/08/03/rogers-ls35a/">
      Rogers LS3/5A #R10046 ¥398,000(税込) スピーカー
    </a>
    <a href="/webshop/2025/02/01/mcintosh-mc500/">
      McIntosh MC500 マッキントッシュ ステレオパワーアンプ #R09231 ¥558,300(税込) McIntosh
    </a>`);

  assert.equal(items.length, 2);
  assert.equal(items[0].model, "LS3/5A");
  assert.equal(items[0].rawCategory, "スピーカー");
  assert.equal(items[0].metadata?.rewireSellerCategory, undefined);
  assert.equal(items[1].model, "MC500");
  assert.equal(items[1].rawCategory, "McIntosh");
  assert.equal(items[1].metadata?.rewireSellerCategory, undefined);
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

test("REWIRE parser ignores script bodies closed with an attributed end tag", () => {
  const scripted = `
<section class="used-products">
  <article>
    <a href="/webshop/2026/08/03/paradigm-founder-120h/">
      <script>window.badge = "Sold Out ¥1,000(税込) アンプ";</script${"\t\n      data-extra"}>
      Paradigm Founder 120H #R10045 ¥778,800(税込) スピーカー
    </a>
  </article>
</section>`;

  const [product] = parseRewireListing(scripted);
  assert.equal(product.title, "Paradigm Founder 120H");
  assert.equal(product.priceYen, 778800);
  assert.equal(product.rawCategory, "スピーカー");
  assert.equal(product.stockStatus, "in_stock");
});
