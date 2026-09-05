import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { resolveModel } from "../src/catalog/model-resolver.js";
import { splitManufacturerModel } from "../src/crawler/normalize.js";
import { parseProductPage } from "../src/crawler/parser.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { audioUnionAdapter } from "../src/crawler/shops/audiounion.js";
import { parseHifidoListing } from "../src/crawler/shops/hifido.js";
import { parseShimamusenListing } from "../src/crawler/shops/shimamusen.js";
import { parseTereonListing, discoverTereonPageUrls } from "../src/crawler/shops/tereon.js";
import { parseOsakayaListing } from "../src/crawler/shops/osakaya.js";
import { parseAfroAudioListing } from "../src/crawler/shops/afroaudio.js";
import { parseRewireListing } from "../src/crawler/shops/rewire.js";

// Minimal markup transcribed from the shops' listing pages. No seller images or descriptions.
test("AudioUnion reads separate maker/model fields without sacrificing digit-free model names", () => {
  const html = `<ul>
    <li class="even item first-child"><div class="maker_name"><a>Ferrum Audio</a></div>
      <div class="item_name"><a href="/ct/detail/used/226451/">HYPSOS</a></div>
      <span class="category">DCパワーサプライ</span><span class="selling_price">79,800円</span>売約済</li>
    <li class="odd item"><div class="maker_name"><a>SFORZATO</a></div>
      <div class="item_name"><a href="/ct/detail/used/226408/">DSP-Corvus</a></div>
      <span class="category">ネットワークプレーヤー</span><span class="selling_price">198,000円</span></li>
    <li class="item"><span class="maker_name">YAMAHA</span>
      <span class="item_name"><a href="/ct/detail/used/226458/">CD-S2100</a></span>
      <span class="selling_price">168,000円</span></li>
    <li class="item"><span class="maker_name">Austrian Audio</span>
      <span class="item_name"><a href="/ct/detail/used/226065/">The Composer</a></span>
      <span class="selling_price">248,000円</span></li></ul><footer>完売</footer>`;
  const products = audioUnionAdapter.parse(html);
  assert.deepEqual(
    products.map((p) => [p.rawManufacturer, p.model, p.priceYen, p.stockStatus]),
    [
      ["Ferrum Audio", "HYPSOS", 79800, "sold_out"],
      ["SFORZATO", "DSP-Corvus", 198000, "in_stock"],
      ["YAMAHA", "CD-S2100", 168000, "in_stock"],
      ["Austrian Audio", "The Composer", 248000, "in_stock"],
    ],
  );
  assert.equal(products[1].rawCategory, "ネットワークプレーヤー");
});

test("Fujiya reads nested bilingual fields and the selling price rather than a crossed-out price", () => {
  const html = `<dl class="block-thumbnail-t--goods js-enhanced-ecommerce-item">
    <dt><a href="/shop/g/g200000069157/">画像</a></dt><dd>
    <div class="block-thumbnail-t--goods-brand"><div class="txt-en">Layfic Tone</div><div class="txt-ja">レイフィックトーン</div></div>
    <div class="block-thumbnail-t--goods-name">オプションバランスケーブル 4pinXLR [LT-TIOPW-XLR4]</div>
    <div class="block-thumbnail-t--goods-condition">中古：AB</div>
    <s>74,800円</s><div class="js-enhanced-ecommerce-goods-price">59,840円</div>
    <img alt="在庫あり"></dd></dl>
    <dl class="block-thumbnail-t--goods"><a href="/shop/g/g200000062150/">画像</a>
    <div class="block-thumbnail-t--goods-brand"><div class="txt-en">水月雨（MoonDrop）</div><div class="txt-ja">スイゲツアメ</div></div>
    <div class="block-thumbnail-t--goods-name">清泉-Spring Tips (Sサイズ/3ペア)</div>
    <div class="js-enhanced-ecommerce-goods-price">1,080円</div><img alt="在庫なし"></dl>`;
  const page = {
    url: "https://www.fujiya-avic.co.jp/shop/e/ea-outlet/",
    feed: "outlet-stock-sale",
  };
  const products = getShopPlugin("fujiya-avic")!.parse(html, page);
  assert.equal(products[0].manufacturer, "Layfic Tone");
  assert.equal(products[0].rawModel, "オプションバランスケーブル 4pinXLR [LT-TIOPW-XLR4]");
  assert.equal(products[0].priceYen, 59840);
  assert.equal(products[0].stockStatus, "in_stock");
  assert.equal(products[1].rawModel, "清泉-Spring Tips (Sサイズ/3ペア)");
  assert.equal(products[1].priceYen, 1080);
  assert.equal(products[1].stockStatus, "sold_out");
});

test("Ippinkan ignores commented prices and neighboring sold listings", () => {
  const html = `<div class="innerBox"><p class="name"><a href="/shopdetail/000000001001/">LUXMAN - L-505uXII《JP-u》</a></p>
    <p class="price">198,000円</p>売り切れ</div>
    <div class="innerBox"><p class="name"><a href="/shopdetail/000000001002/">AIRBOW - CD6007 Special《JP-u》</a></p>
    <!--div class="icon_d">1円 SOLD OUT</div--><p class="price">89,800円</p></div>`;
  const products = getShopPlugin("ippinkan")!.parse(html, "https://ippinkan.jp/shopbrand/U100000/");
  assert.deepEqual(
    products.map((p) => [p.manufacturer, p.priceYen, p.stockStatus]),
    [
      ["LUXMAN", 198000, "sold_out"],
      ["AIRBOW", 89800, "in_stock"],
    ],
  );
});

test("Hifido reads makers without list prices, exact genres, and timed arrivals", () => {
  const html = `<div class="list-item"><div class="list-title"><h3><a id="type-24-41724-03234-00" href="/24-41724-03234-00.html">FM-20K-600CT</a></h3>注文</div>
    <div id="maker-24-41724-03234-00"><div>メーカー:<a>NOGUCHI<apan> ノグチ</apan></a></div></div>
    <div id="price-24-41724-03234-00"><div>売価(ペア):12,800円(税込)</div></div>
    <div id="genre-24-41724-03234-00"><div><a>パーツ</a></div></div>
    <div id="arrival-24-41724-03234-00">2026-09-05<span> 20:02:04</span>入荷</div></div>
    <div class="list-item"><a href="/26-50960-20639-00.html">Falcon M1</a>
      <div id="maker-26-50960-20639-00"><div>メーカー:サンハヤト サンハヤト</div></div>
      <div>売価(セット):2,800円</div><div id="genre-26-50960-20639-00"><div>シェル</div></div>注文</div>
    <footer>売約済</footer>`;
  const products = parseHifidoListing(html);
  assert.equal(products[0].manufacturer, "NOGUCHI");
  assert.equal(products[0].rawManufacturer, "NOGUCHI ノグチ");
  assert.equal(products[0].rawCategory, "パーツ");
  assert.equal(products[0].sourcePublishedAt, "2026-09-05T11:02:04.000Z");
  assert.equal(products[1].manufacturer, "サンハヤト");
  assert.equal(products[1].rawCategory, "シェル");
  assert.equal(products[1].stockStatus, "in_stock");
});

test("Shimamusen bounds malformed cards before reading each maker and price", () => {
  const products =
    parseShimamusenListing(`<div class="innerBox"><a href="/shopdetail/000000001001/">Jeff Rowland Model102S</a>
    <span class="maker">Jeff Rowland</span><p>88,000円</p>売り切れ
    <div class="innerBox"><a href="/shopdetail/000000001002/">Luna Cables GRIS RCA</a>
    <span class="maker">Luna Cables</span><p>45,000円</p></div>`);
  assert.deepEqual(
    products.map((p) => [p.manufacturer, p.model, p.priceYen, p.stockStatus]),
    [
      ["Jeff Rowland", "Model102S", 88000, "sold_out"],
      ["Luna Cables", "GRIS RCA", 45000, "in_stock"],
    ],
  );
});

test("Tereon excludes navigation from products and pagination while preserving bundles", () => {
  const page = {
    url: "https://www.tereon-tsuhan.com/shopbrand/004/X/",
    page: 1,
    conditionCode: "004" as const,
    conditionText: "中古品" as const,
  };
  const html = `<aside><a href="/shopdetail/005000000001/">カートリッジキーパー</a></aside><p>全4件</p><table>
    <tr><td><a href="/shopdetail/000000008252/">中古品：JBL 4329P(JS-80付)(元箱なし)(パワードスピーカー)</a></td><td>JBL</td><td>368,000円</td></tr>
    <tr><td><a href="/shopdetail/000000008221/">中古品：TRIODE TRZ-300W-WE300B(PSVANE WE300B仕様)(元箱あり)</a></td><td>TRIODE</td><td>228,000円</td></tr></table>`;
  const products = getShopPlugin("tereon")!.parse(html, page);
  assert.deepEqual(
    products.map((p) => p.model),
    ["4329P(JS-80付)", "TRZ-300W-WE300B(PSVANE WE300B仕様)"],
  );
  assert.equal(discoverTereonPageUrls(html, page)?.length, 1);
  assert.match(products[0].rawModel, /元箱なし/u);
});

test("Tereon retains explicit unfamiliar multi-word makers and independent title evidence", () => {
  assert.equal(
    resolveModel({ rawModel: "TRX-1(WE300B)", manufacturerId: "", shopKey: "tereon" }).model,
    "TRX-1(WE300B)",
  );
  assert.equal(
    resolveModel({ rawModel: "DG-58(F5Y555)", manufacturerId: "accuphase", shopKey: "tereon" })
      .model,
    "DG-58",
  );
  const items =
    parseTereonListing(`<table><tr><td><a href="/shopdetail/000000007599/">展示品：Monitor Audio PL100Ⅱ(PL100ⅡSTANDS付)</a></td><td>Monotor Audio</td><td>198,000円</td></tr>
    <tr><td><a href="/shopdetail/000000007600/">中古品：Unlisted Audio The Composer(4Ω)</a></td><td>Unlisted Audio</td><td>58,000円</td></tr></table>`);
  assert.equal(items[0].rawManufacturer, "Monotor Audio");
  assert.equal(items[0].manufacturer, "Monitor Audio");
  assert.equal(items[0].model, "PL100II(PL100IISTANDS付)");
  assert.equal(items[1].manufacturer, "Unlisted Audio");
  assert.equal(items[1].model, "The Composer(4Ω)");
});

test("Osakaya uses heading lines for identity and retains cable length from the type label", () => {
  const html = `<a href="/store/items/power-amp/1885/"><h3 class="list-title">Constellation Audio コンステレーションオーディオ<br>MONO1.0<br><strong>モノラルパワーアンプ</strong></h3>1,980,000円</a>
    <a href="/store/items/cable/2117/"><h3 class="list-title">GOURD ゴード<br>GCP-600<br><strong>ACケーブル(1.8m)</strong></h3>19,800円</a>`;
  const items = parseOsakayaListing(html);
  assert.deepEqual(
    items.map((p) => [p.manufacturer, p.model]),
    [
      ["Constellation Audio", "MONO1.0"],
      ["GOURD", "GCP-600(1.8m)"],
    ],
  );
});

test("AfroAudio removes explicit product-type suffixes without losing options and quantities", () => {
  const titles = [
    "MUSICAL FIDELITY A3 CD CDデッキ ミュージカルフィデリティ",
    "Lite Audio DAC-AH D/Aコンバーター ライトオーディオ",
    "Accuphase F-15L 周波数ボード付 チャンネルデバイダー アキュフェーズ",
    "UNITED ELECTRONICS CUE 211W/VT-4C 2本 マッチドペア 真空管 ユナイテッドエレクトロニクス",
    "TRIAD HSM-94 トランス2個 トライアッド",
  ];
  const html = titles
    .map(
      (title, index) =>
        `<a href="/products/detail/${1000 + index}">${title} @${2000 + index} ¥88,000 在庫あり</a>`,
    )
    .join("");
  assert.deepEqual(
    parseAfroAudioListing(html).map((p) => [p.manufacturer, p.model]),
    [
      ["MUSICAL FIDELITY", "A3 CD"],
      ["Lite Audio", "DAC-AH"],
      ["Accuphase", "F-15L 周波数ボード付"],
      ["UNITED ELECTRONICS", "CUE 211W/VT-4C 2本 マッチドペア"],
      ["TRIAD", "HSM-94 2個"],
    ],
  );
});

test("REWIRE preserves slash-separated bundles, cable lengths, and set quantities", () => {
  const titles = [
    "McIntosh XRT22 / MQ107 マッキントッシュ スピーカー",
    "AudioQuest Rocket 88.2 スピーカーケーブル 2m ペア",
    "TAD Reference One / TAD-R1 3本(LCR Set) / Pioneer TAD スピーカーシステム",
    "SOULNOTE P-3 2026年製 ソウルノート プリアンプ",
  ];
  const html = titles
    .map(
      (title, index) =>
        `<a href="/webshop/2026/08/01/product-${index}/">${title} ¥198,000(税込) スピーカー</a>`,
    )
    .join("");
  const items = parseRewireListing(html);
  assert.equal(items[0].model, "XRT22 / MQ107");
  assert.equal(items[1].model, "Rocket 88.2 2m");
  assert.equal(items[2].model, "Reference One / TAD-R1 3本(LCR Set)");
  assert.equal(items[3].model, "P-3");
});

test("JSON-LD brand/model fields take precedence over title guesses and commented offers", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", url: "/product/1024", name: "The Composer", brand: { name: "Unlisted Audio" }, model: "The Composer", category: "ヘッドホン", offers: { price: 198000, availability: "https://schema.org/InStock" } })}</script>
    <!-- <a href="/product/1999">Fake Brand X-1 1円</a> -->
    <a href="/product/1024">Unlisted Audio The Composer 商品詳細</a><p>198,000円</p>`;
  const items = parseProductPage(html, {
    shopKey: "generic",
    baseUrl: "https://example.com",
    productUrlPattern: /\/product\//u,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].manufacturer, "Unlisted Audio");
  assert.equal(items[0].model, "The Composer");
  assert.equal(items[0].rawCategory, "ヘッドホン");
  assert.equal(items[0].priceYen, 198000);
});

test("verified multi-word prefixes repair legacy manufacturer truncation on normalization replay", () => {
  for (const [manufacturer, model] of [
    ["Jeff Rowland", "Model102S"],
    ["First Watt", "SIT-3"],
    ["YG Acoustics", "SUMMIT"],
    ["STORM AUDIO", "ISP 16 ANALOG MK3"],
    ["My Sonic Lab", "Ultra Eminent Bc"],
  ]) {
    assert.deepEqual(splitManufacturerModel(`${manufacturer} ${model}`, "generic"), {
      manufacturer,
      model,
    });
    const legacy = normalizeCatalogProduct({
      sourceId: "legacy",
      sourceUrl: "https://example.com/item/legacy",
      conditionText: "中古",
      priceYen: 10000,
      stockStatus: "in_stock",
      rawManufacturer: manufacturer.split(" ")[0],
      manufacturer: manufacturer.split(" ")[0],
      rawModel: manufacturer.split(" ").slice(1).join(" ") + " " + model,
      model: manufacturer.split(" ").slice(1).join(" ") + " " + model,
      title: `${manufacturer} ${model}`,
    });
    assert.equal(legacy.manufacturer, manufacturer);
    assert.equal(legacy.model, model);
  }
});
