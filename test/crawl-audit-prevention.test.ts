import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { splitManufacturerModel } from "../src/crawler/normalize.js";
import { getShopPlugin, SHOP_PLUGINS } from "../src/crawler/shops/index.js";
import { extractFujiyaDetailCategoryEvidence } from "../src/crawler/shops/fujiya-avic.js";
import { classifyCategoryEvidence } from "../src/catalog/category-classifier.js";
import type { CrawlPage } from "../src/crawler/types.js";
import type { SoundPitPage } from "../src/crawler/shops/soundpit.js";
import { enrichProductCategories } from "../src/crawler/category-enricher.js";
import { detailFetchOptions, emptyCatalogDb } from "./helpers/fixtures.js";
import type { ExistingCategoryEnrichmentState } from "../src/db/types.js";
import { discoverLinkedPages } from "../src/crawler/html-listing.js";
import { bootstrapManufacturers } from "../src/catalog/manufacturers.js";
import { createManufacturerResolver } from "../src/catalog/manufacturer-resolver.js";
import { listManufacturerAliasEvidence } from "../src/db/manufacturer-repository.js";
import { resolveProductCatalogFields } from "../src/db/model-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

// Minimal factual markup, not copies of seller descriptions. A visible control proves each
// hidden-markup assertion exercises the shop's parser instead of passing on an invalid fixture.
const listings: readonly (readonly [string, string, (CrawlPage | SoundPitPage)?])[] = [
  [
    "audiounion",
    `<li class="item"><span class="maker_name">LUXMAN</span><span class="item_name"><a href="/ct/detail/used/226458/">C-10X</a></span><span class="selling_price">198,000円</span></li>`,
  ],
  [
    "ippinkan",
    `<div class="innerBox"><a href="/shopdetail/000000027683/">HEGEL - H80《JP-u》</a><p>135,000円</p></div>`,
  ],
  [
    "fujiya-avic",
    `<dl class="block-thumbnail-t--goods"><a href="/shop/g/g240001213813/">画像</a><div class="block-thumbnail-t--goods-brand"><span class="txt-en">Volumio</span></div><div class="block-thumbnail-t--goods-name">Rivo Black Edition</div><span class="js-enhanced-ecommerce-goods-price">104,800円</span></dl>`,
  ],
  [
    "hifido",
    `<div class="list-item"><a href="/26-51001-14001-00.html">D-10X</a><div id="maker-26-51001-14001-00">メーカー:LUXMAN ラックスマン</div><div>売価:980,000円</div><div id="genre-26-51001-14001-00">SACD/CDプレーヤー</div>注文</div>`,
  ],
  [
    "formusic",
    `<tr id="post-36856"><td></td><td>FOSTEX</td><td><a href="/speaker-accessories/36856.html">P-1000BH + FE103NV</a></td><td>売価</td><td><span class="post-meta-baika">22,000 円</span></td><td></td><td></td><td><img alt="中古"></td></tr>`,
  ],
  [
    "u-audio",
    `<a href="/view/item/000000009999">No.5206 / Mark Levinson</a> 商品コード 99999 販売価格（税込） ￥980,000 カートに入れる`,
  ],
  [
    "shimamusen",
    `<div class="innerBox"><a href="/shopdetail/000000001001/">Jeff Rowland Model102S</a><span class="maker">Jeff Rowland</span><p>88,000円</p></div>`,
  ],
  [
    "dynamic-audio",
    `<article id="post-101"><h2 class="entry-title"><a href="https://dynamicaudio5used.wordpress.com/2026/09/07/item/">Accuphase DG-68</a></h2><p>中古品＠音声プロセッサー</p><p>販売価格: 498,000円</p></article>`,
  ],
  [
    "afroaudio",
    `<a href="/products/detail/1000">Accuphase F-15L チャンネルデバイダー @2000 ¥88,000 在庫あり</a>`,
  ],
  [
    "osakaya",
    `<a href="/store/items/power-amp/1885/"><h3 class="list-title">Constellation Audio<br>MONO1.0<br><strong>モノラルパワーアンプ</strong></h3>1,980,000円</a>`,
  ],
  [
    "soundpit",
    `<h2>Burmester</h2><h2>911 MK3</h2><p>ステレオパワーアンプ 中古品</p><p>¥1,793,000</p><a href="/pg102.html">Power amp/一覧へ戻る</a>`,
    { url: "https://sound-pit.jp/pg530.html", kind: "detail" },
  ],
  ["sound-support", `<a href="/26477.html">NuPrime IDA-8</a> 販売価格：￥58,000 程度：A`],
  [
    "avac",
    `<a href="/buy/products/detail/50001">〖中古〗LUXMAN MU-80〖コード10-100488〗8chパワーアンプ</a><p>￥327,800</p>`,
  ],
  [
    "tereon",
    `<table><tr><td><a href="/shopdetail/000000008252/">中古品：JBL 4329P</a></td><td>JBL</td><td>368,000円</td></tr></table>`,
  ],
  [
    "audio-space-core",
    `<h3>スピーカー（ペア）</h3><table><tr><td></td><td><a href="/CHEVIOT">CHEVIOT</a></td><td></td><td>タンノイ</td><td>￥1,254,000</td><td>￥598,000</td></tr></table>`,
  ],
  [
    "rewire",
    `<a href="/webshop/2026/08/01/product-1/">McIntosh XRT22 / MQ107 スピーカー ¥198,000(税込) スピーカー</a>`,
  ],
  ["home-shokai", `<a href="/item.php?z=101">LUXMAN プリアンプ C-10X 委託販売品 ￥980,000</a>`],
];

test("hidden-markup regression controls cover every registered shop", () => {
  assert.deepEqual(
    listings.map(([key]) => key).sort(),
    SHOP_PLUGINS.map((shop) => shop.key).sort(),
  );
});

test("shared pagination cannot be expanded by script or comment links", () => {
  const options = {
    baseUrl: "https://example.com",
    currentPage: 1,
    pageNumber: (url: URL) => Number(url.searchParams.get("page")),
    createPage: (page: number) => page,
  };
  const visible = '<a href="?page=2">次へ</a>';
  for (const hidden of [
    '<!--<a href="?page=100">次へ</a>-->',
    '<script>const page = `<a href="?page=100">次へ</a>`;</script>',
  ]) {
    assert.deepEqual(discoverLinkedPages(`${hidden}${visible}`, options), [2]);
  }
});

for (const [shop, html, page] of listings) {
  test(`${shop}: hidden templates and comments cannot create seller listings`, () => {
    const plugin = getShopPlugin(shop)!;
    const visible = plugin.parse(html, page);
    assert.equal(visible.length, 1, "visible control");
    for (const hidden of [
      `<!--${html}-->`,
      `<script>const template = ${JSON.stringify(html)};</script>`,
      `<style>${html}</style>`,
    ]) {
      assert.equal(plugin.parse(hidden, page).length, 0, hidden.slice(0, 50));
      const mixed = plugin.parse(`${hidden}${html}${hidden}`, page);
      assert.equal(mixed.length, 1);
      assert.equal(mixed[0].model, visible[0].model);
      assert.equal(mixed[0].manufacturer, visible[0].manufacturer);
      assert.equal(mixed[0].priceYen, visible[0].priceYen);
      assert.equal(mixed[0].stockStatus, visible[0].stockStatus);
    }
  });
}

test("Fujiya fallback retains Japanese model names and bracketed SKUs", () => {
  assert.deepEqual(splitManufacturerModel("NOBUNAGA Labs 比叡 鎧 [NLC-HEI-GAI]", "fujiya-avic"), {
    manufacturer: "NOBUNAGA Labs",
    model: "比叡 鎧 [NLC-HEI-GAI]",
  });
  assert.deepEqual(splitManufacturerModel("Unique Melody 望 [UNM-9999]", "fujiya-avic"), {
    manufacturer: "Unique Melody",
    model: "望 [UNM-9999]",
  });
  assert.deepEqual(
    splitManufacturerModel(
      "Bowers & Wilkins バウワースアンドウィルキンス FS-700S3/B",
      "fujiya-avic",
    ),
    {
      manufacturer: "Bowers & Wilkins",
      model: "FS-700S3/B",
    },
  );
});

test("bootstrap manufacturer aliases remain compatible with the migrated operational identities", async () => {
  const { db } = migratedSqlite();
  const aliases = await listManufacturerAliasEvidence(db);
  const resolve = createManufacturerResolver(aliases);
  for (const manufacturer of bootstrapManufacturers()) {
    for (const rawManufacturer of [manufacturer.name, ...manufacturer.aliases]) {
      const result = resolve({ rawManufacturer });
      assert.equal(result.status, "resolved", rawManufacturer);
      assert.equal(result.canonicalManufacturerId, manufacturer.id, rawManufacturer);
    }
  }
  const plugin = getShopPlugin("fujiya-avic")!;
  const [parsed] = plugin.parse(
    '<a href="/shop/g/g240001299999/">Pioneer DJ パイオニアディージェー DDJ-FLX4</a><p>39,800円</p>',
  );
  assert.equal(parsed.rawManufacturer, "Pioneer DJ");
  const [resolved] = await resolveProductCatalogFields(db, [parsed], {
    shopKey: plugin.key,
    aliases,
  });
  assert.equal(resolved.manufacturerId, "pioneer");
  assert.equal(resolved.manufacturerResolutionStatus, "resolved");
  assert.equal(resolved.model, "DDJ-FLX4");
});

test("Fujiya detail classification cannot start in site navigation", () => {
  const evidence = extractFujiyaDetailCategoryEvidence(
    `<nav>Rivo Black Edition イヤーパッド</nav><main><h1>Rivo Black Edition</h1><p>Rivo Black Edition ネットワークトランスポート</p></main><footer>イヤホンケーブル</footer>`,
    { model: "Rivo Black Edition" },
  );
  assert.equal(classifyCategoryEvidence(evidence).primaryCategoryId, "SRC.STREAMER");
  assert.deepEqual(
    extractFujiyaDetailCategoryEvidence(
      `<nav>Rivo Black Edition イヤーパッド</nav><main><h1>OTHER PRODUCT</h1><p>CDプレーヤー</p></main>`,
      { model: "Rivo Black Edition" },
    ),
    [],
  );
});

test("Ippinkan uses only the matched product's explicit category field", async () => {
  const extract = getShopPlugin("ippinkan")!.capabilities.detailCategoryEvidence?.extract;
  assert.ok(extract, "bounded detail enrichment must be registered");
  const product = getShopPlugin("ippinkan")!.parse(
    listings.find(([key]) => key === "ippinkan")![1],
  )[0];
  const html = `<nav>スピーカー イヤホン</nav><h2>HEGEL - H80《JP-u》</h2><table><tr><th>カテゴリー</th><td>プリメインアンプ</td></tr><tr><th>付属品</th><td>リモコン・電源ケーブル</td></tr></table>`;
  assert.equal(
    classifyCategoryEvidence(await extract(html, product)).primaryCategoryId,
    "AMP.INTEGRATED",
  );
  assert.deepEqual(await extract(html.replace("HEGEL - H80", "OTHER - X100"), product), []);
  assert.equal(
    classifyCategoryEvidence(
      await extract(
        html.replace("<h2>", "<h1>逸品館</h1><h2>").replace("<table>", "<h3>商品情報</h3><table>"),
        product,
      ),
    ).primaryCategoryId,
    "AMP.INTEGRATED",
  );
  assert.deepEqual(
    await extract(
      `<h2>HEGEL - H80</h2><p>付属品：リモコン 電源ケーブル</p><footer><table><tr><th>カテゴリー</th><td>スピーカー</td></tr></table></footer>`,
      product,
    ),
    [],
  );
});

test("Home Shokai does not promote a model-name guess into authoritative seller category", () => {
  const [product] = getShopPlugin("home-shokai")!.parse(
    `<a href="/item.php?z=501">Marantz MA500 委託販売品 ￥38,000</a>`,
  );
  assert.equal(product.rawCategory, "");
  assert.equal(product.primaryCategoryId, "unclassified");
});

test("detail categories require product identity and do not concatenate accessory fields", async () => {
  const product = { model: "EVOLVE" };
  for (const html of [
    `<h1>EVOLVE</h1><table><tr><th>付属品</th><td>イヤーパッド・電源ケーブル</td></tr></table>`,
    `<h1>OTHER PRODUCT</h1><h2>EVOLVE</h2><p>EVOLVE ヘッドホン</p>`,
    `<h1>EVOLVE</h1><aside><aside>EVOLVE イヤーパッド</aside></aside>`,
    `<!--<meta name="description" content="EVOLVE イヤーパッド">--><h1>EVOLVE</h1>`,
    `<h1>EVOLVE</h1><p>EVOLVEの付属品：イヤーパッド</p>`,
    `<template><meta name="description" content="EVOLVE イヤーパッド"></template><h1>EVOLVE</h1>`,
  ])
    assert.deepEqual(extractFujiyaDetailCategoryEvidence(html, product), []);
  assert.deepEqual(extractFujiyaDetailCategoryEvidence(`<p>EVOLVE ヘッドホン</p>`), []);
  const extract = getShopPlugin("ippinkan")!.capabilities.detailCategoryEvidence!.extract;
  const item = getShopPlugin("ippinkan")!.parse(
    listings.find(([key]) => key === "ippinkan")![1],
  )[0];
  assert.deepEqual(
    await extract(
      `<h2>HEGEL H800</h2><table><tr><th>カテゴリー</th><td>プリメインアンプ</td></tr></table>`,
      item,
    ),
    [],
  );
});

test("Ippinkan enrichment is limited to unresolved identities and respects the request cap", async () => {
  const adapter = getShopPlugin("ippinkan")!;
  const product = adapter.parse(listings.find(([key]) => key === "ippinkan")![1])[0];
  assert.equal(product.classificationStatus, "unclassified");
  const cap = adapter.capabilities.catalog!.categoryPolicy!.enrichment!.maxRequestsPerCrawl!;
  const products = Array.from({ length: cap + 2 }, (_, index) => ({
    ...product,
    sourceId: `h-${index}`,
    sourceUrl: `https://ippinkan.jp/shopdetail/${index}/`,
    model: `H-${index}`,
    title: `HEGEL H-${index}`,
  }));
  const requests: string[] = [];
  const result = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter,
    products: [...products, { ...products[0], sourceId: "duplicate" }],
    existingRows: [],
    transport: {
      async fetchHtmlPage(url) {
        requests.push(url);
        const index = Number(url.split("/").at(-2));
        return `<h2>HEGEL H-${index}</h2><table><tr><th>カテゴリー</th><td>プリメインアンプ</td></tr></table>`;
      },
    },
    fetchOptions: detailFetchOptions(),
    now: new Date("2026-09-07T00:00:00Z"),
  });
  assert.equal(requests.length, cap);
  assert.equal(result.detailRequests, cap);
  assert.equal(result.products.at(-1)?.primaryCategoryId, "AMP.INTEGRATED");
  assert.equal(result.products[cap].classificationStatus, "unclassified");
  const classified = await enrichProductCategories({
    db: emptyCatalogDb(),
    adapter,
    products: [result.products[0]],
    existingRows: [],
    transport: {
      async fetchHtmlPage() {
        throw new Error("already classified must not fetch");
      },
    },
    fetchOptions: detailFetchOptions(),
  });
  assert.equal(classified.detailRequests, 0);
});

test("Fujiya refreshes old positive and negative extraction caches without invalidating other shops", async () => {
  const adapter = getShopPlugin("fujiya-avic")!;
  const product = adapter.parse(listings.find(([key]) => key === "fujiya-avic")![1])[0];
  assert.equal(product.classificationStatus, "unclassified");
  for (const state of ["classified", "unclassified"] as const) {
    const row: ExistingCategoryEnrichmentState = {
      source_id: product.sourceId,
      manufacturer_id: product.manufacturerId,
      model: product.model,
      title: product.title,
      category: "イヤーパッド",
      primary_category_id: "ACC.WEAR",
      category_ids: '["ACC.WEAR"]',
      classification_status: state,
      search_aliases: "",
      metadata_json: JSON.stringify({
        categoryClassification: {
          ...product.metadata.categoryClassification,
          state,
          detailCheckedAt: "2026-09-06T23:00:00Z",
          detailExtractorVersion: 2,
        },
      }),
    };
    const result = await enrichProductCategories({
      db: emptyCatalogDb(),
      adapter,
      products: [product],
      existingRows: [row],
      transport: {
        async fetchHtmlPage() {
          return `<h1>Rivo Black Edition</h1><p>Rivo Black Edition ネットワークトランスポート</p>`;
        },
      },
      fetchOptions: detailFetchOptions(),
      now: new Date("2026-09-07T00:00:00Z"),
    });
    assert.equal(result.detailRequests, 1);
    assert.equal(result.cacheHits, 0);
    assert.equal(result.products[0].primaryCategoryId, "SRC.STREAMER");
    assert.equal(result.products[0].metadata.categoryClassification.detailExtractorVersion, 3);
    const refreshed = result.products[0];
    const cached = await enrichProductCategories({
      db: emptyCatalogDb(),
      adapter,
      products: [product],
      existingRows: [
        {
          ...row,
          category: refreshed.category,
          primary_category_id: refreshed.primaryCategoryId,
          category_ids: JSON.stringify(refreshed.categoryIds),
          classification_status: "classified",
          metadata_json: JSON.stringify(refreshed.metadata),
        },
      ],
      transport: {
        async fetchHtmlPage() {
          throw new Error("current extractor cache must be reused");
        },
      },
      fetchOptions: detailFetchOptions(),
      now: new Date("2026-09-07T01:00:00Z"),
    });
    assert.equal(cached.detailRequests, 0);
    assert.equal(cached.cacheHits, 1);
    assert.equal(cached.products[0].primaryCategoryId, "SRC.STREAMER");
  }
  assert.equal(getShopPlugin("hifido")!.capabilities.detailCategoryEvidence!.version, undefined);
});
