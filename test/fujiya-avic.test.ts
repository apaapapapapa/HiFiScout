import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  extractFujiyaDetailCategoryEvidence,
  fujiyaAvicAdapter,
  parseFujiyaResultCount,
} from "../src/crawler/shops/fujiya-avic.js";
import { coverageDecision, initialPageQueue } from "../src/crawler/strategies.js";
import { classifyCategoryEvidence } from "../src/catalog/category-classifier.js";

// Structural selectors observed on the ANDROMEDA seller page, with minimal synthetic content.
function productTrail(categories: readonly string[], model = "ANDROMEDA", id = "240004022011") {
  return `<ul class="block-topic-path--list" id="bread-crumb-list" itemtype="https://schema.org/BreadcrumbList">
    <li class="block-topic-path--item__home"><a href="/shop/default.aspx">トップ</a></li>
    ${categories.map((name) => `<li class="block-topic-path--genre-item"><a href="/shop/r/rA-EAP/">${name}</a></li>`).join("")}
    <li class="block-topic-path--genre-item block-topic-path--item__current"><a href="/shop/g/g${id}/">${model}</a></li>
  </ul>`;
}

test("Fujiya product-bound breadcrumbs classify model-only listings and ignore shared navigation", () => {
  const html = `<header><h1>フジヤエービック</h1><nav>ヘッドホン スピーカー ケーブル</nav></header>
    ${productTrail(["イヤホン"])}${productTrail(["イヤホン", "カナル型イヤホン", "カナル型イヤホン(中古)"])}
    <main><h2>ANDROMEDA</h2><p>在庫がありません</p></main>`;
  const evidence = extractFujiyaDetailCategoryEvidence(html, {
    model: "ANDROMEDA",
    sourceUrl: "https://www.fujiya-avic.co.jp/shop/g/g240004022011/",
  });
  assert.equal(classifyCategoryEvidence(evidence).primaryCategoryId, "PER.EARPHONE");
  assert.equal(evidence[0].source, "detail_breadcrumb");
  assert.equal(evidence[0].ruleId, "fujiya.product_breadcrumb.v3");
});

test("Fujiya terminal accessory buckets do not inherit their earphone ancestor", () => {
  for (const [terminal, expected] of [
    ["イヤーピース", "ACC.WEAR"],
    ["イヤホンケース", "ACC.CASE"],
    ["イヤホンケーブル", "CAB.PERSONAL"],
    ["未対応アクセサリー", "unclassified"],
  ]) {
    const html = `${productTrail(["イヤホン"], "X1")}${productTrail(["イヤホン", terminal], "X1")}<main><h2>X1</h2></main>`;
    assert.equal(
      classifyCategoryEvidence(extractFujiyaDetailCategoryEvidence(html, { model: "X1" }))
        .primaryCategoryId,
      expected,
      terminal,
    );
  }
});

test("Fujiya rejects unrelated product trails and keeps conflicting evidence ambiguous", () => {
  const identity = {
    model: "X1",
    sourceUrl: "https://www.fujiya-avic.co.jp/shop/g/g240004022011/",
  };
  for (const trail of [
    productTrail(["イヤホン"], "X2"),
    productTrail(["イヤホン"], "X1", "999999999999"),
  ]) {
    assert.deepEqual(
      extractFujiyaDetailCategoryEvidence(`${trail}<main><h2>X1</h2></main>`, identity),
      [],
    );
  }
  const conflicting = `${productTrail(["イヤホン"], "X1")}${productTrail(["ヘッドホン"], "X1")}<main><h2>X1</h2></main>`;
  assert.equal(
    classifyCategoryEvidence(extractFujiyaDetailCategoryEvidence(conflicting, identity))
      .classificationState,
    "ambiguous",
  );
  const metadataConflict = `<head><meta name="description" content="X1はヘッドホンです。"></head>${productTrail(["イヤホン"], "X1")}<main><h2>X1</h2></main>`;
  assert.equal(
    classifyCategoryEvidence(extractFujiyaDetailCategoryEvidence(metadataConflict, identity))
      .classificationState,
    "ambiguous",
  );
  assert.deepEqual(
    extractFujiyaDetailCategoryEvidence(
      `${productTrail(["イヤホン"], "X1")}<main><h2>X2</h2></main>`,
      identity,
    ),
    [],
  );
});

function initialPages() {
  return initialPageQueue(fujiyaAvicAdapter, 50);
}

test("Fujiya initial crawl includes newest used, outlet, and outlet stock sale feeds", () => {
  const pages = initialPages();
  assert.equal(pages.length, 3);
  assert.equal(pages[0].url, "https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd/?ps=50");
  assert.equal(pages[0].feed, "new-arrivals");
  assert.equal(pages[1].url, "https://www.fujiya-avic.co.jp/shop/c/c31/?ps=50");
  assert.equal(pages[1].feed, "outlet");
  assert.equal(pages[2].url, "https://www.fujiya-avic.co.jp/shop/e/ea-outlet/?ps=50");
  assert.equal(pages[2].feed, "outlet-stock-sale");
});

test("Fujiya bounded feeds are explicit partial coverage", () => {
  assert.equal(fujiyaAvicAdapter.discovery.coverage, "partial");

  const decision = coverageDecision(fujiyaAvicAdapter, {
    reachedEnd: false,
    coverageIncomplete: false,
    queueEmpty: true,
  });

  assert.equal(decision.deactivateMissing, false);
  assert.equal(decision.validateItemCount, false);
});

test("Fujiya pagination is derived independently from each live result count", () => {
  assert.equal(parseFujiyaResultCount("<div>検索結果735件</div>"), 735);
  assert.equal(parseFujiyaResultCount("<div>該当件数391件</div>"), 391);
  assert.equal(parseFujiyaResultCount("<div>44件あります</div>"), 44);

  const [usedRoot, outletRoot, saleRoot] = initialPages();
  const usedPages = fujiyaAvicAdapter.discovery.discoverTargets?.(
    "<div>検索結果735件</div>",
    usedRoot,
  );
  assert.ok(usedPages);
  assert.equal(usedPages.length, 14);
  assert.equal(usedPages[0].url, "https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd_p2/?ps=50");
  const lastUsedPage = usedPages.at(-1);
  assert.ok(lastUsedPage);
  assert.match(lastUsedPage.url, /ea-usednw_ssd_p15\/\?ps=50$/);
  assert.ok(usedPages.every((page) => page.feed === "new-arrivals"));

  const outletPages = fujiyaAvicAdapter.discovery.discoverTargets?.(
    "<div>101件あります</div>",
    outletRoot,
  );
  assert.ok(outletPages);
  assert.equal(outletPages.length, 2);
  assert.equal(outletPages[0].url, "https://www.fujiya-avic.co.jp/shop/c/c31_dP_p2/?ps=50");
  assert.equal(outletPages[1].url, "https://www.fujiya-avic.co.jp/shop/c/c31_dP_p3/?ps=50");
  assert.ok(outletPages.every((page) => page.feed === "outlet"));

  const salePages = fujiyaAvicAdapter.discovery.discoverTargets?.(
    "<div>検索結果72件</div>",
    saleRoot,
  );
  assert.ok(salePages);
  assert.equal(salePages.length, 1);
  assert.equal(salePages[0].url, "https://www.fujiya-avic.co.jp/shop/e/ea-outlet_p2/?ps=50");
  assert.equal(salePages[0].feed, "outlet-stock-sale");
});

test("Fujiya refuses to claim complete discovery when count cannot be discovered", () => {
  const [root] = initialPages();
  assert.equal(
    fujiyaAvicAdapter.discovery.discoverTargets?.("<html>layout changed</html>", root),
    null,
  );
});

test("Fujiya live-card shape parses price, rank, stock and bilingual maker correctly", () => {
  const page = {
    url: "https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd/?ps=50",
    feed: "new-arrivals",
  };
  const html = `
    <div class="product">
      <img alt="在庫あり">
      <div>中古：AB</div>
      <a href="/shop/g/g240001214761/">Bowers & Wilkins バウワースアンドウィルキンス FS-700S3/B</a>
      <span>￥57,900(税込)</span>
    </div>`;
  const [item] = fujiyaAvicAdapter.parse(html, page);
  assert.equal(item.manufacturer, "Bowers & Wilkins");
  assert.equal(item.model, "FS-700S3/B");
  assert.equal(item.priceYen, 57900);
  assert.equal(item.conditionText, "中古：AB");
  assert.equal(item.stockStatus, "in_stock");
  assert.equal(item.sourceUrl, "https://www.fujiya-avic.co.jp/shop/g/g240001214761/");
});

test("Fujiya outlet cards are collected as outlet inventory", () => {
  const page = {
    url: "https://www.fujiya-avic.co.jp/shop/c/c31/?ps=50",
    feed: "outlet",
  };
  const html = `
    <div class="product">
      <img alt="在庫あり">
      <div>アウトレット</div>
      <a href="/shop/g/g123456789012/">DENON デノン DP-200USB-K</a>
      <span>￥19,800(税込)</span>
    </div>`;
  const [item] = fujiyaAvicAdapter.parse(html, page);
  assert.equal(item.manufacturer, "DENON");
  assert.equal(item.model, "DP-200USB-K");
  assert.equal(item.priceYen, 19800);
  assert.equal(item.conditionText, "アウトレット");
  assert.equal(item.stockStatus, "in_stock");
  assert.equal(item.sourceUrl, "https://www.fujiya-avic.co.jp/shop/g/g123456789012/");
});

test("Fujiya outlet stock sale preserves the card condition and canonical product URL", () => {
  const page = {
    url: "https://www.fujiya-avic.co.jp/shop/e/ea-outlet/?ps=50",
    feed: "outlet-stock-sale",
  };
  const html = `
    <div class="product">
      <img alt="在庫あり">
      <div>新品</div>
      <div>在庫セール</div>
      <a href="/shop/g/g987654321000/">Cayin カイン N7 [SPK-A003]</a>
      <span>￥169,800(税込)</span>
    </div>`;
  const [item] = fujiyaAvicAdapter.parse(html, page);
  assert.equal(item.manufacturer, "Cayin");
  assert.equal(item.model, "N7 [SPK-A003]");
  assert.equal(item.priceYen, 169800);
  assert.notEqual(item.conditionText, "アウトレット");
  assert.equal(item.stockStatus, "in_stock");
  assert.equal(item.sourceUrl, "https://www.fujiya-avic.co.jp/shop/g/g987654321000/");
});

test("Fujiya price is taken from the current card, not the previous card", () => {
  const page = {
    url: "https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd/?ps=50",
    feed: "new-arrivals",
  };
  const html = `
    <div class="product">
      <img alt="在庫あり">
      <div>中古：AB+</div>
      <a href="/shop/g/g240001300001/">SilentPower サイレントパワー OMNI USB [SLP-OMNI-USB]</a>
      <span>￥119,300(税込)</span>
    </div>
    <div class="product">
      <img alt="在庫あり">
      <div>中古：AB+</div>
      <a href="/shop/g/g240001300002/">SilentPower サイレントパワー OMNI USB [SLP-OMNI-USB]</a>
      <span>￥119,800(税込)</span>
    </div>`;
  const items = fujiyaAvicAdapter.parse(html, page);
  assert.equal(items.length, 2);
  assert.equal(items[0].priceYen, 119300);
  assert.equal(items[1].priceYen, 119800);
});

test("Fujiya DJ/DTM listings remain classifiable from the new arrivals feed", () => {
  const page = {
    url: "https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd/?ps=50",
    feed: "new-arrivals",
  };
  const html = `
    <div class="product">
      <img alt="在庫あり">
      <div>中古：AB+</div>
      <a href="/shop/g/g240001299999/">Pioneer DJ パイオニアディージェー DDJ-FLX4</a>
      <span>￥39,800(税込)</span>
    </div>`;
  const [item] = fujiyaAvicAdapter.parse(html, page);
  assert.equal(item.category, "DJ機器・DTM");
  assert.equal(item.manufacturer, "Pioneer DJ");
  assert.equal(item.model, "DDJ-FLX4");
  assert.equal(item.priceYen, 39800);
  assert.equal(item.stockStatus, "in_stock");
});

test("Fujiya detail evidence ignores script bodies closed with an attributed end tag", () => {
  const evidence = extractFujiyaDetailCategoryEvidence(
    `<html><body>
      <script>window.analytics = { copy: "MODEL10/FBはパワーアンプです。" };</script${"\t\n      data-extra"}>
      <p>MODEL10/FBはプリメインアンプです。</p>
    </body></html>`,
    { model: "MODEL10/FB" },
  );
  assert.deepEqual(
    evidence.map((item) => item.categoryIds),
    [["AMP.INTEGRATED"]],
  );
});
