import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  avacAdapter,
  discoverAvacPageUrls,
  parseAvacListing,
  type AvacPage,
} from "../src/crawler/shops/avac.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { discoverPages, initialPageQueue } from "../src/crawler/strategies.js";

const audioPage: AvacPage = {
  url: "https://www.avac.co.jp/buy/used/products/list?category_id=3007&sale_type=2",
  page: 1,
  categoryId: 3007,
  rawCategory: "中古 -AUDIO製品(全商品)-",
};

const listingHtml = `
<div class="product">
  <a href="/buy/products/detail/50001"><img src="luxman.jpg"></a>
  <a href="/buy/products/detail/50001">〖中古〗LUXMAN MU-80〖コード10-100488〗8chパワーアンプ</a>
  <p>￥327,800 (税込)</p>
  <p>〖中古用〗1～2日後</p>
  <button>カートに入れる</button>
</div>
<div class="product">
  <a href="/buy/products/detail/50002">〖アウトレット〗KOJO Crystal EpL(1本)〖コード91-1000010〗LAN(RJ45)型仮想アース</a>
  <p>￥20,900 (税込)</p>
  <button>カートに入れる</button>
</div>
<div class="product">
  <a href="/buy/products/detail/50005">〖展示処分品〗DALI OBERON7(DW)〖コードW-OBERON7DW〗フロア型スピーカー（ペア）</a>
  <p>￥106,000(税込)</p>
  <button>カートに入れる</button>
</div>
<div class="product">
  <a href="/buy/products/detail/50003">※特価※〖中古〗ONKYO A-7VL-特〖コード22-100268〗プリメインアンプ</a>
  <p>￥49,800 (税込)</p>
  <button>カートに入れる</button>
</div>
<div class="product">
  <a href="/buy/products/detail/50006">〖新品〗DENON PMA-1700NE〖コードNEW-001〗プリメインアンプ</a>
  <p>￥198,000 (税込)</p>
  <button>カートに入れる</button>
</div>`;

test("AVAC parser includes used, outlet and display-disposal inventory", () => {
  const products = parseAvacListing(listingHtml, audioPage);
  assert.equal(products.length, 4);

  assert.deepEqual(products[0], {
    sourceId: "50001",
    sourceUrl: "https://www.avac.co.jp/buy/products/detail/50001",
    title: "LUXMAN MU-80",
    rawManufacturer: "LUXMAN",
    manufacturer: "LUXMAN",
    model: "MU-80",
    rawCategory: "8chパワーアンプ",
    category: "パワーアンプ",
    conditionText: "中古",
    priceYen: 327800,
    stockStatus: "in_stock",
    metadata: {
      productCode: "10-100488",
      avacBrowseCategory: "中古 -AUDIO製品(全商品)-",
    },
  });

  assert.equal(products[1]?.sourceId, "50002");
  assert.equal(products[1]?.title, "KOJO Crystal EpL(1本)");
  assert.equal(products[1]?.conditionText, "アウトレット");

  assert.equal(products[2]?.sourceId, "50005");
  assert.equal(products[2]?.title, "DALI OBERON7(DW)");
  assert.equal(products[2]?.conditionText, "展示処分品");
  assert.equal(products[2]?.rawCategory, "フロア型スピーカー（ペア）");
  assert.equal(products[2]?.category, "スピーカー");

  assert.equal(products[3]?.sourceId, "50003");
  assert.equal(products[3]?.title, "ONKYO A-7VL");
  assert.equal(products[3]?.model, "A-7VL");
  assert.equal(products[3]?.rawCategory, "プリメインアンプ");
  assert.equal(products[3]?.category, "プリメインアンプ");
  assert.equal(products[3]?.conditionText, "中古");
});

test("AVAC parser preserves sold-out evidence and removes seller shipping suffixes", () => {
  const html = `
  <div class="product">
    <a href="https://www.avac.co.jp/buy/products/detail/50004">〖中古〗TANNOY Canterbury15-送料別途〖コード22-100244〗フロア型スピーカー(ペア)</a>
    <p>￥1,280,000(税込)</p>
    <p>この商品は完売しました。</p>
  </div>`;

  const [product] = parseAvacListing(html, audioPage);
  assert.ok(product);
  assert.equal(product.title, "TANNOY Canterbury15");
  assert.equal(product.sourceId, "50004");
  assert.equal(product.priceYen, 1280000);
  assert.equal(product.stockStatus, "sold_out");
  assert.equal(product.conditionText, "中古");
});

test("AVAC pagination stays inside the current used category", () => {
  const html = `
  <a href="/buy/used/products/list?category_id=3007&pageno=2&sale_type=2">2</a>
  <a href="/buy/used/products/list?category_id=3007&pageno=5&sale_type=2">最後へ</a>
  <a href="/buy/used/products/list?category_id=3171&pageno=9&sale_type=2">other category</a>
  <a href="/buy/used/products/list?category_id=3007&pageno=20&sale_type=1">wrong sale type</a>
  <a href="https://example.com/buy/used/products/list?category_id=3007&pageno=99&sale_type=2">external</a>`;

  assert.deepEqual(
    discoverAvacPageUrls(html, audioPage),
    [2, 3, 4, 5].map((page) => ({
      url: `https://www.avac.co.jp/buy/used/products/list?category_id=3007&pageno=${page}&sale_type=2`,
      page,
      categoryId: 3007,
      rawCategory: "中古 -AUDIO製品(全商品)-",
    })),
  );
});

test("AVAC adapter covers audio plus the HiFi-relevant VISUAL leaves", () => {
  const initial = initialPageQueue(avacAdapter, 50);
  assert.deepEqual(
    initial.map((page) => ({ categoryId: page.categoryId, rawCategory: page.rawCategory })),
    [
      { categoryId: 3007, rawCategory: "中古 -AUDIO製品(全商品)-" },
      { categoryId: 3171, rawCategory: "中古 AVアンプ" },
      { categoryId: 3174, rawCategory: "中古 センタースピーカー" },
      { categoryId: 3175, rawCategory: "中古 サブウーファー" },
    ],
  );
  assert.equal(avacAdapter.discovery.coverage, "complete");
  assert.deepEqual(discoverPages(avacAdapter, "", audioPage), []);

  const plugin = getShopPlugin("avac");
  assert.ok(plugin);
  assert.equal(plugin.definition.defaultIntervalMinutes, 140);
  assert.equal(plugin.definition.defaultMaxPages, 50);
  assert.equal(plugin.definition.envPrefix, "AVAC");
});
