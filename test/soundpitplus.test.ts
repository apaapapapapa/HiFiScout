import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  parseSoundPitPlusDetail,
  soundPitPlusAdapter,
  type SoundPitPlusPage,
} from "../src/crawler/shops/soundpitplus.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { coverageDecision, discoverPages, initialPageQueue } from "../src/crawler/strategies.js";
import { getShopEnabled, getShopMaxPages, getShopRequestDelayMs } from "../src/config.js";
import { isPathAllowed } from "../src/crawler/robots.js";

// Minimal factual markup observed 2026-11-08, without seller media or descriptions beyond the
// one-line lead the parser reads. Observed post ids/names/prices; posts 900-902 and the detail
// variants below are synthetic counterexamples. The markup stays comment-free so hidden-markup
// tests can wrap it in one valid HTML comment, and inline because every tracked file under
// test/fixtures is part of each load-cost sample profile.
const listing = `
<main id="main" class="site-main hfeed">
  <article id="post-99" class="post-99 page type-page status-publish hentry">
    <header class="entry-header"><h1 class="page-title">USED products</h1></header>
    <div class="entry-content is-layout-constrained">
      <nav class="spcn-nav" aria-label="商品カテゴリー"><a href="https://soundpit-plus.com/used-products/" aria-current="page">ALL</a><a href="https://soundpit-plus.com/used-products/?sp_category=amplifier">AMPLIFIER</a><a href="https://soundpit-plus.com/used-products/?sp_category=player">PLAYER</a></nav>
      <div data-id="spcn-8cdfe6b0" class="wp-block-blocksy-query">
        <div class="ct-query-template-grid">
          <article class="wp-block-post is-layout-flow post-794 products type-products status-publish has-post-thumbnail hentry product_status-used">
            <div class="wp-block-group"><a class="ct-dynamic-media" aria-label="【委託品】Brinkmann audio RöNt II" href="https://soundpit-plus.com/products/brinkmann-ront-ii/"></a>
              <div class="wp-block-group">
                <h2 class="ct-dynamic-data has-text-align-center"><a href="https://soundpit-plus.com/products/brinkmann-ront-ii/">【委託品】Brinkmann audio RöNt II</a></h2>
                <div class="ct-dynamic-data"><time datetime="2026-11-06T16:28:10+09:00" itemprop="datePublished">2026-11-06</time></div>
              </div>
            </div>
          </article>
          <article class="wp-block-post is-layout-flow post-715 products type-products status-publish has-post-thumbnail hentry product_status-sold product_status-used">
            <div class="wp-block-group"><a class="ct-dynamic-media" aria-label="LUXMAN PD-191A" href="https://soundpit-plus.com/products/luxman-pd-191a/"></a>
              <div class="wp-block-group">
                <h2 class="ct-dynamic-data has-text-align-center"><a href="https://soundpit-plus.com/products/luxman-pd-191a/">LUXMAN PD-191A</a></h2>
                <div class="ct-dynamic-data"><time datetime="2026-10-16T12:00:00+09:00" itemprop="datePublished">2026-10-16</time></div>
              </div>
            </div>
          </article>
          <article class="wp-block-post is-layout-flow post-714 products type-products status-publish has-post-thumbnail hentry product_status-used">
            <div class="wp-block-group"><a class="ct-dynamic-media" aria-label="SOULNOTE A-3" href="https://soundpit-plus.com/products/soulnote-a-3/"></a>
              <div class="wp-block-group">
                <h2 class="ct-dynamic-data has-text-align-center"><a href="https://soundpit-plus.com/products/soulnote-a-3/">SOULNOTE A-3</a></h2>
                <div class="ct-dynamic-data"><time datetime="2026-10-16T11:00:00+09:00" itemprop="datePublished">2026-10-16</time></div>
              </div>
            </div>
          </article>
          <article class="wp-block-post is-layout-flow post-900 products type-products status-publish hentry product_status-new">
            <div class="wp-block-group">
              <h2 class="ct-dynamic-data"><a href="https://soundpit-plus.com/products/example-new-model/">Example New Model</a></h2>
            </div>
          </article>
          <article class="wp-block-post is-layout-flow post-901 products type-products status-publish hentry product_status-used">
            <div class="wp-block-group">
              <h2 class="ct-dynamic-data"><a href="https://example.com/products/example-foreign/">Example Foreign</a></h2>
            </div>
          </article>
          <article class="wp-block-post is-layout-flow post-902 post type-post status-publish hentry category-news">
            <div class="wp-block-group">
              <h2 class="ct-dynamic-data"><a href="https://soundpit-plus.com/products/example-blog/">Example Blog</a></h2>
            </div>
          </article>
        </div>
      </div>
      <nav class="spcn-pages" aria-label="商品一覧のページ"><a href="https://soundpit-plus.com/used-products/" aria-current="page">1</a><a href="https://soundpit-plus.com/used-products/?sp_page=2">2</a></nav>
    </div>
  </article>
</main>
`;
const listingPage2 = `
<main id="main" class="site-main hfeed">
  <article id="post-99" class="post-99 page type-page status-publish hentry">
    <div class="entry-content is-layout-constrained">
      <div data-id="spcn-8cdfe6b0" class="wp-block-blocksy-query">
        <div class="ct-query-template-grid">
          <article class="wp-block-post is-layout-flow post-372 products type-products status-publish has-post-thumbnail hentry product_status-used">
            <div class="wp-block-group">
              <h2 class="ct-dynamic-data has-text-align-center"><a href="https://soundpit-plus.com/products/burmester-911-mk3/">Burmester 911 MK3</a></h2>
            </div>
          </article>
        </div>
      </div>
      <nav class="spcn-pages" aria-label="商品一覧のページ"><a href="https://soundpit-plus.com/used-products/">1</a><a href="https://soundpit-plus.com/used-products/?sp_page=2" aria-current="page">2</a></nav>
    </div>
  </article>
</main>
`;
const detail = `
<main id="main" class="site-main hfeed">
  <div class="ct-container-full">
    <article id="post-714" class="post-714 products type-products status-publish has-post-thumbnail hentry product_status-used">
      <div class="hero-section is-width-constrained" data-type="type-1">
        <header class="entry-header"><nav class="spcn-nav spcn-product-nav" aria-label="商品カテゴリー"><a href="https://soundpit-plus.com/used-products/">ALL</a><a href="https://soundpit-plus.com/used-products/?sp_category=amplifier" aria-current="true">AMPLIFIER</a><a href="https://soundpit-plus.com/used-products/?sp_category=player">PLAYER</a></nav>
          <h1 class="page-title" itemprop="headline">SOULNOTE A-3</h1>
        </header>
      </div>
      <div class="entry-content is-layout-constrained">
        <p class="wp-block-paragraph">製品名：SOULNOTE A-3</p>
        <p class="item-price wp-block-paragraph">中古品：￥1,078,000-(税込)</p>
        <p class="wp-block-paragraph">付属品：リモコン、電源ケーブル</p>
        <p class="wp-block-paragraph">元箱：有り</p>
        <p class="wp-block-paragraph">※配送料別途</p>
        <div class="wp-block-buttons"><div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/item-inquiry/?product-name=SOULNOTE%20A-3">商品について問い合わせる</a></div></div>
        <p class="wp-block-paragraph">ソウルノートのプリメインアンプ「A-3」の中古品です。</p>
        <p class="wp-block-paragraph">同社のプリアンプ「P-3」とパワーアンプ「M-3」の技術を採用しています。</p>
        <div class="entry-tags is-width-constrained spcn-detail-tags"><span class="ct-module-title">商品区分・カテゴリ</span><div class="entry-tags-items"><a href="https://soundpit-plus.com/product_status/used/"><span>#</span> USED</a><a href="https://soundpit-plus.com/used-products/?sp_category=amplifier"><span>#</span> AMPLIFIER</a></div></div>
      </div>
      <div class="entry-tags is-width-constrained"><span class="ct-module-title">商品区分</span><div class="entry-tags-items"><a href="https://soundpit-plus.com/product_status/used/" rel="tag"><span>#</span> USED</a></div></div>
      <nav class="post-navigation is-width-constrained">
        <a href="https://soundpit-plus.com/products/luxman-pd-191a/" class="nav-item-prev"><span class="item-label">前へ ITEM</span><span class="item-title">LUXMAN PD-191A</span></a>
        <a href="https://soundpit-plus.com/products/accuphase-c-3900/" class="nav-item-next"><span class="item-label">次へ ITEM</span><span class="item-title">Accuphase C-3900</span></a>
      </nav>
    </article>
  </div>
</main>
`;

const BASE = "https://soundpit-plus.com";
const firstPage: SoundPitPlusPage = { url: `${BASE}/used-products/`, kind: "listing", page: 1 };
const secondPage: SoundPitPlusPage = {
  url: `${BASE}/used-products/?sp_page=2`,
  kind: "listing",
  page: 2,
};
const a3Page: SoundPitPlusPage = {
  url: `${BASE}/products/soulnote-a-3/`,
  kind: "detail",
  postId: "714",
  listingSold: false,
};

function variant(replacements: ReadonlyArray<readonly [string | RegExp, string]>): string {
  return replacements.reduce<string>((html, [from, to]) => html.replace(from, to), detail);
}

const plugin = getShopPlugin("soundpitplus")!;

test("SOUNDPIT+ discovers listing pagination first, then one detail target per used card", () => {
  assert.deepEqual(initialPageQueue(soundPitPlusAdapter, 60), [firstPage]);
  assert.deepEqual(discoverPages(soundPitPlusAdapter, listing, firstPage), [
    secondPage,
    {
      url: `${BASE}/products/brinkmann-ront-ii/`,
      kind: "detail",
      postId: "794",
      listingSold: false,
    },
    { url: `${BASE}/products/luxman-pd-191a/`, kind: "detail", postId: "715", listingSold: true },
    a3Page,
  ]);
  // The last page names no later page; it adds only its own cards.
  assert.deepEqual(discoverPages(soundPitPlusAdapter, listingPage2, secondPage), [
    {
      url: `${BASE}/products/burmester-911-mk3/`,
      kind: "detail",
      postId: "372",
      listingSold: false,
    },
  ]);
  // Price-less listing pages are discovery only.
  assert.deepEqual(plugin.parse(listing, firstPage), []);
  assert.deepEqual(plugin.parse(listingPage2, secondPage), []);
});

test("SOUNDPIT+ carries unknown listing statuses into the detail availability decision", () => {
  const withHold = listing.replace(
    "post-714 products type-products status-publish has-post-thumbnail hentry product_status-used",
    "post-714 products type-products status-publish has-post-thumbnail hentry product_status-used product_status-hold",
  );
  const heldPage = (discoverPages(soundPitPlusAdapter, withHold, firstPage) ?? []).find(
    (page) => page.kind === "detail" && page.postId === "714",
  );
  assert.deepEqual(heldPage, { ...a3Page, listingUnknownStatus: true });
  assert.equal(parseSoundPitPlusDetail(detail, heldPage)[0].stockStatus, "unknown");
  // Unrelated product cards keep their original availability evidence.
  assert.deepEqual(
    (discoverPages(soundPitPlusAdapter, withHold, firstPage) ?? []).find(
      (page) => page.kind === "detail" && page.postId === "715",
    ),
    { url: `${BASE}/products/luxman-pd-191a/`, kind: "detail", postId: "715", listingSold: true },
  );
});

test("SOUNDPIT+ follows only its own unfiltered listing pagination", () => {
  const page2Link = `${BASE}/used-products/?sp_page=2`;
  for (const href of [
    "https://example.com/used-products/?sp_page=2",
    `${BASE}/used-products/?sp_category=amplifier&amp;sp_page=2`,
    `${BASE}/new-products/?sp_page=2`,
    `${BASE}/used-products/?sp_page=0`,
  ]) {
    const targets = discoverPages(soundPitPlusAdapter, listing.replace(page2Link, href), firstPage);
    assert.deepEqual(
      targets?.filter((target) => typeof target !== "string" && target.kind === "listing"),
      [],
      href,
    );
  }
  // Category links outside the page navigation are not pagination.
  const navigationOnly = listing.replace(/<nav class="spcn-pages"[\s\S]*?<\/nav>/u, "");
  assert.equal(
    discoverPages(soundPitPlusAdapter, navigationOnly, firstPage)?.some(
      (target) => typeof target !== "string" && target.kind === "listing",
    ),
    false,
  );
});

test("SOUNDPIT+ discovery ignores hidden cards and fails closed on an unknown layout", () => {
  const emptyGrid = '<div class="ct-query-template-grid"></div>';
  assert.deepEqual(discoverPages(soundPitPlusAdapter, emptyGrid, firstPage), []);
  for (const hidden of [`<!--${listing}-->`, `<script>${JSON.stringify(listing)}</script>`]) {
    assert.deepEqual(discoverPages(soundPitPlusAdapter, `${hidden}${emptyGrid}`, firstPage), []);
  }
  assert.equal(discoverPages(soundPitPlusAdapter, "<html>maintenance</html>", firstPage), null);
  assert.deepEqual(discoverPages(soundPitPlusAdapter, detail, a3Page), []);
});

test("SOUNDPIT+ detail parser reads the post's own labelled facts and seller lead", () => {
  const [product] = parseSoundPitPlusDetail(detail, a3Page);
  assert.deepEqual(product, {
    sourceId: "714",
    sourceUrl: `${BASE}/products/soulnote-a-3/`,
    title: "SOULNOTE A-3",
    rawManufacturer: "SOULNOTE",
    manufacturer: "SOULNOTE",
    model: "A-3",
    rawCategory: "プリメインアンプ",
    category: "",
    conditionText: "中古品",
    priceYen: 1_078_000,
    stockStatus: "in_stock",
    metadata: {
      soundPitPlusCategory: "AMPLIFIER",
      accessories: "リモコン、電源ケーブル",
      originalBox: "有り",
    },
  });
  const [normalized] = plugin.parse(detail, a3Page);
  assert.equal(normalized.primaryCategoryId, "AMP.INTEGRATED");
  assert.equal(normalized.manufacturerId, "soulnote");
});

test("SOUNDPIT+ maps SOLD, negotiating, unknown and contradictory status evidence", () => {
  const sold = variant([["product_status-used", "product_status-sold product_status-used"]]);
  const [soldOut] = parseSoundPitPlusDetail(sold, { ...a3Page, listingSold: true });
  assert.equal(soldOut.stockStatus, "sold_out");
  assert.equal(soldOut.priceYen, null, "a sold listing's last price is not an offer");

  // The card and the detail page disagree: neither observation is conclusive.
  assert.equal(parseSoundPitPlusDetail(sold, a3Page)[0].stockStatus, "unknown");
  const [cardSold] = parseSoundPitPlusDetail(detail, { ...a3Page, listingSold: true });
  assert.equal(cardSold.stockStatus, "unknown");
  assert.equal(cardSold.priceYen, null);
  // Without card context the detail page decides.
  assert.equal(
    parseSoundPitPlusDetail(sold, { ...a3Page, listingSold: undefined })[0].stockStatus,
    "sold_out",
  );

  const otherTerm = variant([["product_status-used", "product_status-hold product_status-used"]]);
  assert.equal(parseSoundPitPlusDetail(otherTerm, a3Page)[0].stockStatus, "unknown");
  const notUsed = variant([["product_status-used", "product_status-new"]]);
  assert.equal(parseSoundPitPlusDetail(notUsed, a3Page)[0].stockStatus, "unknown");
  const soldAndHold = variant([
    ["product_status-used", "product_status-sold product_status-hold product_status-used"],
  ]);
  assert.equal(
    parseSoundPitPlusDetail(soldAndHold, { ...a3Page, listingSold: true })[0].stockStatus,
    "unknown",
  );

  for (const marker of ["商談中", "HOLD", "予約済"]) {
    const priceHeld = variant([["￥1,078,000-(税込)", `￥1,078,000-(税込) ${marker}`]]);
    const [product] = parseSoundPitPlusDetail(priceHeld, a3Page);
    assert.equal(product.stockStatus, "unknown", marker);
    assert.equal(product.conditionText, "中古品 / 商談中", marker);
  }

  const negotiating = variant([[">SOULNOTE A-3</h1>", ">【商談中】SOULNOTE A-3</h1>"]]);
  const [held] = parseSoundPitPlusDetail(negotiating, a3Page);
  assert.equal(held.stockStatus, "unknown");
  assert.equal(held.title, "SOULNOTE A-3");
  assert.equal(held.conditionText, "中古品 / 商談中");
  assert.equal(held.priceYen, 1_078_000);
});

test("SOUNDPIT+ keeps consignment context, inquiry-only prices and unfamiliar maker spellings", () => {
  const consignment = variant([
    [">SOULNOTE A-3</h1>", ">【委託品】Brinkmann audio RöNt II</h1>"],
    ["中古品：￥1,078,000-(税込)", "委託中古品：￥400,000-(税込)"],
    [
      "ソウルノートのプリメインアンプ「A-3」の中古品です。",
      "ドイツのブランド、Brinkmann audioが開発した真空管式ターンテーブル専用電源ユニット「RöNt II」。",
    ],
  ]);
  const [brinkmann] = parseSoundPitPlusDetail(consignment, {
    url: `${BASE}/products/brinkmann-ront-ii/`,
    kind: "detail",
  });
  assert.equal(brinkmann.title, "Brinkmann audio RöNt II");
  assert.equal(brinkmann.rawManufacturer, "Brinkmann audio");
  assert.equal(brinkmann.model, "RöNt II");
  assert.equal(brinkmann.rawCategory, "電源ユニット");
  assert.equal(brinkmann.priceYen, 400_000);
  assert.equal(brinkmann.conditionText, "中古品 / 委託品");
  assert.equal(brinkmann.metadata?.consignment, true);
  assert.equal(brinkmann.metadata?.listingLabel, "委託品");

  const ask = variant([
    [">SOULNOTE A-3</h1>", ">Reference DAC</h1>"],
    ["中古品：￥1,078,000-(税込)", "販売価格：￥ASK-&nbsp;"],
    [
      "ソウルノートのプリメインアンプ「A-3」の中古品です。",
      "MSBのD/Aコンバーター「Reference DAC」の中古品です。",
    ],
  ]);
  const [reference] = parseSoundPitPlusDetail(ask, a3Page);
  assert.equal(reference.priceYen, null);
  assert.equal(reference.stockStatus, "in_stock");
  assert.equal(reference.rawManufacturer, "", "the title names no maker");
  assert.equal(reference.model, "Reference DAC");
  assert.equal(plugin.parse(ask, a3Page)[0].primaryCategoryId, "PRC.DAC");

  const bundle = variant([
    [">SOULNOTE A-3</h1>", ">上杉研究所 U・BROS-220DSR + U-BROS-KC1</h1>"],
    ["中古品：￥1,078,000-(税込)", "中古品：¥896,500-/セット(税込)"],
    [
      "ソウルノートのプリメインアンプ「A-3」の中古品です。",
      "上杉研究所の光カートリッジ専用真空管式フォノイコライザー「U-BROS-220DSR」と",
    ],
  ]);
  const [uesugi] = parseSoundPitPlusDetail(bundle, a3Page);
  assert.equal(uesugi.rawManufacturer, "上杉研究所");
  assert.equal(uesugi.model, "U・BROS-220DSR + U-BROS-KC1");
  assert.equal(uesugi.rawCategory, "フォノイコライザー");
  assert.equal(uesugi.priceYen, 896_500);
  assert.equal(plugin.parse(bundle, a3Page)[0].primaryCategoryId, "AMP.PHONO");
});

test("SOUNDPIT+ falls back to the seller bucket when the lead is not about this product", () => {
  const otherModel = variant([
    [
      "ソウルノートのプリメインアンプ「A-3」の中古品です。",
      "同社のプリアンプ「P-3」の技術を継承しています。",
    ],
  ]);
  const [product] = parseSoundPitPlusDetail(otherModel, a3Page);
  assert.equal(product.rawCategory, "AMPLIFIER");
  assert.equal(product.rawManufacturer, "SOULNOTE");
  assert.equal(product.model, "A-3");
  assert.equal(plugin.parse(otherModel, a3Page)[0].primaryCategoryId, "unclassified");

  const wrongQuotedRevision = variant([["のプリメインアンプ「A-3」", "のプリアンプ「A-3 MKII」"]]);
  const [wrongRevision] = parseSoundPitPlusDetail(wrongQuotedRevision, a3Page);
  assert.equal(wrongRevision.rawCategory, "AMPLIFIER");
  assert.equal(wrongRevision.rawManufacturer, "SOULNOTE");
  assert.equal(wrongRevision.model, "A-3");

  const titleRevision = variant([[">SOULNOTE A-3</h1>", ">SOULNOTE A-3 MKII</h1>"]]);
  const [titleWithRevision] = parseSoundPitPlusDetail(titleRevision, a3Page);
  assert.equal(titleWithRevision.rawCategory, "AMPLIFIER");
  assert.equal(titleWithRevision.model, "A-3 MKII");

  const similarModel = variant([[">SOULNOTE A-3</h1>", ">SOULNOTE A-30</h1>"]]);
  assert.equal(parseSoundPitPlusDetail(similarModel, a3Page)[0].rawCategory, "AMPLIFIER");

  const unknownType = variant([["のプリメインアンプ「A-3」", "の試作機「A-3」"]]);
  assert.equal(parseSoundPitPlusDetail(unknownType, a3Page)[0].rawCategory, "AMPLIFIER");
  const noTags = variant([
    [/<div class="entry-tags is-width-constrained spcn-detail-tags">[\s\S]*?<\/div><\/div>/u, ""],
  ]);
  assert.equal(
    parseSoundPitPlusDetail(noTags, a3Page)[0].metadata?.soundPitPlusCategory,
    undefined,
  );
});

test("SOUNDPIT+ never reads another post or a foreign/non-detail page", () => {
  assert.deepEqual(parseSoundPitPlusDetail(detail, { ...a3Page, postId: "715" }), []);
  assert.deepEqual(
    parseSoundPitPlusDetail(detail, {
      ...a3Page,
      url: "https://example.com/products/soulnote-a-3/",
    }),
    [],
  );
  assert.deepEqual(
    parseSoundPitPlusDetail(detail, { ...a3Page, url: `${BASE}/used-products/` }),
    [],
  );
  assert.deepEqual(parseSoundPitPlusDetail(detail, { ...a3Page, kind: "listing" }), []);
  assert.deepEqual(parseSoundPitPlusDetail("<html>maintenance</html>", a3Page), []);
  // Without its own title, a post never borrows a neighbour's name from the post navigation.
  const untitled = variant([
    ['<h1 class="page-title" itemprop="headline">SOULNOTE A-3</h1>', ""],
    ['<p class="wp-block-paragraph">製品名：SOULNOTE A-3</p>', ""],
  ]);
  assert.deepEqual(parseSoundPitPlusDetail(untitled, a3Page), []);
  // The labelled product name stands in for a missing header title.
  const fieldOnly = variant([['<h1 class="page-title" itemprop="headline">SOULNOTE A-3</h1>', ""]]);
  assert.equal(parseSoundPitPlusDetail(fieldOnly, a3Page)[0].title, "SOULNOTE A-3");
  // Query strings and fragments do not create a second identity for the same post.
  const [canonical] = parseSoundPitPlusDetail(detail, {
    ...a3Page,
    url: `${a3Page.url}?utm=x#top`,
  });
  assert.equal(canonical.sourceUrl, a3Page.url);
});

test("SOUNDPIT+ is enabled, bounded and never deactivates absent listings", () => {
  assert.equal(getShopEnabled({}, plugin.definition), true);
  assert.equal(getShopEnabled({ SOUNDPITPLUS_ENABLED: "false" }, plugin.definition), false);
  assert.equal(getShopMaxPages({}, plugin.definition, 40), 60);
  assert.equal(getShopRequestDelayMs({}, plugin.definition, 1200), 2000);
  assert.equal(plugin.definition.defaultIntervalMinutes, 1440);
  assert.equal(plugin.definition.scheduleCron, undefined);
  assert.equal(
    coverageDecision(soundPitPlusAdapter, {
      reachedEnd: true,
      coverageIncomplete: false,
      queueEmpty: true,
    }).deactivateMissing,
    false,
  );
  // Observed robots.txt (2026-11-08): only the WordPress admin is excluded.
  const robots = "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n";
  const targets = [
    firstPage,
    ...(discoverPages(soundPitPlusAdapter, listing, firstPage) ?? []),
    ...(discoverPages(soundPitPlusAdapter, listingPage2, secondPage) ?? []),
  ];
  assert.equal(targets.length, 6);
  for (const target of targets) {
    assert.equal(isPathAllowed(robots, typeof target === "string" ? target : target.url), true);
  }
});
