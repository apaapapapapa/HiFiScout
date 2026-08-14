import test from "node:test";
import assert from "node:assert/strict";
import { SHOP_DEFINITIONS, getShopMaxPages } from "../src/config.js";
import {
  hifidoAdapter,
  hifidoRecheckPage,
  parseHifidoListing,
} from "../src/crawler/shops/hifido.js";
import { isTransportConfigured } from "../src/crawler/transport.js";

test("Hifido parser keeps factual listing fields only", () => {
  const html = `
    <div class="item">
      <script>window.inventory = "sold out";</script${"\t\n        data-extra"}>
      <a href="/26-50234-14194-00.html?A=1&G=3&LNG=J">MINIMA AMATOR 2</a>
      <span>注文</span>
      <p>メーカー:SONUS FABER ソナスファベール</p>
      <p>定価:680,000円</p>
      <p>売価(ペア):498,000円(税込)</p>
      <p>スピーカー（海外製品）</p>
      <p>2026-08-09入荷</p>
      <p>この説明文はDBへ保存しない。</p>
      <img src="/example.jpg" alt="商品画像">
    </div>`;

  const [product] = parseHifidoListing(html);
  assert.equal(product.sourceId, "26-50234-14194-00");
  assert.equal(product.rawManufacturer, "SONUS FABER ソナスファベール");
  assert.equal(product.manufacturer, "SONUS FABER");
  assert.equal(product.model, "MINIMA AMATOR 2");
  assert.equal(product.priceYen, 498000);
  assert.equal(product.rawCategory, "スピーカー");
  assert.equal(product.category, "スピーカー");
  assert.equal(product.stockStatus, "in_stock");
  assert.equal(product.sourceUrl, "https://www.hifido.co.jp/26-50234-14194-00.html?A=1&G=3&LNG=J");
  assert.equal(product.sourcePublishedAt, "2026-08-08T15:00:00.000Z");
  assert.deepEqual(
    Object.keys(product).sort(),
    [
      "category",
      "conditionText",
      "manufacturer",
      "model",
      "priceYen",
      "rawCategory",
      "rawManufacturer",
      "sourceId",
      "sourcePublishedAt",
      "sourceUrl",
      "stockStatus",
      "title",
    ].sort(),
  );
});

test("Hifido parser handles rendered list-item markup with duplicate product links", () => {
  const html = `
    <div class="list-item">
      <div class="list-title">
        <h3><a href="/26-50215-14039-00.html?LNG=J" id="type-26-50215-14039-00">MC240</a></h3>
        <button class="btn1 order_button" id="26-50215-14039-00">注文</button>
      </div>
      <div class="list-photo"><a href="/26-50215-14039-00.html?LNG=J"><img src="/photo.jpg"></a></div>
      <div id="maker-26-50215-14039-00"><div>メーカー:<a href="/?KW=McIntosh">McIntosh<span class="maker-kana"> マッキントッシュ</span></a></div></div>
      <div id="price-26-50215-14039-00"><div>売価:498,000円(税込)</div></div>
      <div id="genre-26-50215-14039-00"><div>パワーアンプ（真空管）</div></div>
      <div>2026-08-10入荷</div>
    </div>`;

  const [product] = parseHifidoListing(html);
  assert.equal(product.sourceId, "26-50215-14039-00");
  assert.equal(product.manufacturer, "McIntosh");
  assert.equal(product.model, "MC240");
  assert.equal(product.priceYen, 498000);
  assert.equal(product.category, "パワーアンプ");
  assert.equal(product.stockStatus, "in_stock");
  assert.equal(product.sourcePublishedAt, "2026-08-09T15:00:00.000Z");
});

test("Hifido keeps three recent pages and adds one rotating stale recheck page", () => {
  const now = new Date("2026-08-11T00:00:00.000Z");
  const pages = [
    ...hifidoAdapter.discovery.initialTargets({
      maxPages: 3,
      env: { HIFIDO_RECHECK_MAX_PAGE: "6" },
      now,
      intervalMinutes: 30,
    }),
  ];
  const recheckPage = hifidoRecheckPage(
    3,
    { HIFIDO_RECHECK_MAX_PAGE: "6" },
    { now, intervalMinutes: 30 },
  );
  assert.ok(recheckPage);
  assert.equal(hifidoAdapter.transport, "relay");
  assert.equal(hifidoAdapter.discovery.coverage, "partial");
  assert.equal(hifidoAdapter.discovery.extraPageAllowance, 1);
  assert.equal(pages.length, 4);
  assert.match(pages[0], /O=0/);
  assert.match(pages[1], /O=30/);
  assert.match(pages[2], /O=60/);
  assert.ok(recheckPage >= 4 && recheckPage <= 6);
  assert.match(pages[3], new RegExp(`O=${(recheckPage - 1) * 30}`));
});

test("Hifido relay transport requires shared crawler relay secrets", () => {
  assert.equal(isTransportConfigured({}, hifidoAdapter), false);
  assert.equal(
    isTransportConfigured(
      {
        CRAWL_RELAY_URL: "https://example.lambda-url.ap-northeast-1.on.aws/",
        CRAWL_RELAY_TOKEN: "token",
      },
      hifidoAdapter,
    ),
    true,
  );
});

test("Hifido rotating recheck advances with the configured crawl interval", () => {
  const env = { HIFIDO_RECHECK_MAX_PAGE: "6" };
  const first = hifidoRecheckPage(3, env, {
    now: new Date("2026-08-11T00:00:00.000Z"),
    intervalMinutes: 30,
  });
  const next = hifidoRecheckPage(3, env, {
    now: new Date("2026-08-11T00:30:00.000Z"),
    intervalMinutes: 30,
  });
  assert.notEqual(first, next);
});

test("Hifido defaults to three recent pages and can be overridden explicitly", () => {
  const definition = SHOP_DEFINITIONS.hifido;
  assert.equal(getShopMaxPages({}, definition, 40), 3);
  assert.equal(getShopMaxPages({ HIFIDO_MAX_PAGES: "2" }, definition, 40), 2);
});

test("Hifido sold listings are not treated as available", () => {
  const html = `
    <div class="item">
      <a href="/26-50000-10000-00.html">A-75</a>
      <span>売約済</span>
      <p>メーカー:Accuphase アキュフェーズ</p>
      <p>売価:1,200,000円(税込) 売約済み</p>
      <p>パワーアンプ（トランジスター）</p>
    </div>`;
  const [product] = parseHifidoListing(html);
  assert.equal(product.stockStatus, "sold_out");
  assert.equal(product.sourcePublishedAt, null);
});
