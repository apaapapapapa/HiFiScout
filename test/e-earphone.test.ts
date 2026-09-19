import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eEarphoneAdapter, parseEEarphoneListing } from "../src/crawler/shops/e-earphone.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { coverageDecision, discoverPages, initialPageQueue } from "../src/crawler/strategies.js";
import { getShopEnabled, getShopMaxPages, getShopRequestDelayMs } from "../src/config.js";
import { isPathAllowed } from "../src/crawler/robots.js";

// Minimal factual markup observed 2026-09-19, without seller media/descriptions. The first
// card uses observed identifiers; other cards are synthetic counterexamples. Keep the fixture
// comment-free so the hidden-markup tests can wrap it in one valid HTML comment.
const fixture = readFileSync(new URL("./fixtures/e-earphone/list.html", import.meta.url), "utf8");
const firstPage = { url: "https://www.e-earphone.jp/collections/recently-used", page: 1 };

test("e-earphone extracts card-scoped seller facts and preserves model revisions, SKUs and bundles", () => {
  const products = parseEEarphoneListing(fixture);
  assert.equal(products.length, 3);
  assert.equal(products[0].sourceId, "778386");
  assert.equal(products[0].sourceUrl, "https://www.e-earphone.jp/products/778386");
  assert.equal(products[0].rawManufacturer, "SENNHEISER");
  assert.equal(products[0].manufacturer, "SENNHEISER");
  assert.equal(products[0].model, "MOMENTUM 4 Wireless ブラック 【M4AEBT BLACK】");
  assert.equal(products[0].rawCategory, "中古ワイヤレスヘッドホン");
  assert.equal(products[0].priceYen, 22_900);
  assert.equal(products[0].stockStatus, "in_stock");
  assert.equal(products[0].conditionText, "中古ランク A");
  assert.equal(products[0].metadata?.storeName, "日本橋");
  assert.equal(products[1].manufacturer, "NOBUNAGA Labs");
  assert.equal(products[1].model, "比叡 鎧 【NLC-HEI-GAI】（ケーブル欠品）");
  assert.equal(products[1].priceYen, 15_900);
  assert.equal(products[1].stockStatus, "sold_out");
  assert.equal(products[1].conditionText, "中古ランク C");
  assert.equal(products[2].manufacturer, "Future Multi Word Audio");
  assert.equal(products[2].model, "Model II + USB DAC");
  assert.equal(products[2].priceYen, null, "list price is not the selling price");
  assert.equal(
    products[2].stockStatus,
    "unknown",
    "a neighboring product's metadata is not stock evidence",
  );
});

test("e-earphone stock remains unknown on contradictory or malformed collection evidence", () => {
  const conflicting = fixture.replace(
    '<div class="grid-product__tags"></div>',
    '<div class="grid-product__tags">売り切れ</div>',
  );
  assert.equal(parseEEarphoneListing(conflicting)[0].stockStatus, "unknown");
  const malformed = fixture.replace(/clct='[^']*'/g, "clct='not JSON'");
  assert.equal(parseEEarphoneListing(malformed)[0].stockStatus, "unknown");
  assert.equal(parseEEarphoneListing(malformed)[0].rawCategory, "");
  assert.equal(parseEEarphoneListing(malformed)[1].stockStatus, "sold_out");
});

test("e-earphone mixed amp/DAC merchandising never overrides product-specific category evidence", () => {
  const plugin = getShopPlugin("e-earphone")!;
  for (const [model, expected] of [
    ["Example D/Aコンバーター DAC", "PRC.DAC"],
    ["Example ヘッドホンアンプ", "AMP.HEADPHONE"],
    ["Unknown Model II", "unclassified"],
  ]) {
    const html = fixture
      .replaceAll("446591140081", "446591205617")
      .replace("MOMENTUM 4 Wireless ブラック 【M4AEBT BLACK】", model);
    const [product] = plugin.parse(html);
    assert.equal(product.rawCategory, "中古アンプ・DAC");
    assert.equal(product.primaryCategoryId, expected, model);
  }
});

test("e-earphone rejects foreign/mismatched links, skips new products and deduplicates listing handles", () => {
  assert.equal(parseEEarphoneListing(fixture + fixture).length, 3);
  assert.equal(
    parseEEarphoneListing(fixture.replaceAll("/products/1002", "https://example.com/products/1002"))
      .length,
    2,
  );
  assert.equal(
    parseEEarphoneListing(fixture.replaceAll('href="/products/1002"', 'href="/products/9999"'))
      .length,
    2,
  );
  assert.deepEqual(parseEEarphoneListing("<html>temporarily unavailable</html>"), []);
  assert.deepEqual(parseEEarphoneListing(`<noscript>${fixture}</noscript>`), []);
  const noMaker = fixture.replace('<div class="grid-product__vendor">NOBUNAGA Labs</div>', "");
  assert.equal(parseEEarphoneListing(noMaker)[1].rawManufacturer, "");
  const unclosed = fixture.replace("</a>\n      </div>\n    </div>", "</a>");
  assert.equal(parseEEarphoneListing(unclosed)[0].priceYen, 22_900);
  assert.equal(parseEEarphoneListing(unclosed)[1].priceYen, 15_900);
});

test("e-earphone follows only the immediate next page of its recent feed", () => {
  assert.deepEqual(initialPageQueue(eEarphoneAdapter, 10), [firstPage]);
  assert.deepEqual(discoverPages(eEarphoneAdapter, fixture, firstPage), [
    { url: `${firstPage.url}?page=2`, page: 2 },
  ]);
  const noNext = fixture.replace(/<span class="next">[\s\S]*?<\/span>/, "");
  assert.deepEqual(discoverPages(eEarphoneAdapter, noNext, firstPage), []);
  assert.equal(discoverPages(eEarphoneAdapter, "<html>unavailable</html>", firstPage), null);
  for (const href of [
    "https://example.com/collections/recently-used?page=2",
    "/collections/46?page=2",
    "/collections/recently-used?page=20",
    "/collections/recently-used?page=2&amp;sort_by=created-descending",
    "/collections/recently-used?page=2&amp;page=3",
  ]) {
    assert.equal(
      discoverPages(
        eEarphoneAdapter,
        fixture.replace("/collections/recently-used?page=2", href),
        firstPage,
      ),
      null,
    );
  }
  assert.deepEqual(discoverPages(eEarphoneAdapter, `<!--${fixture}-->${noNext}`, firstPage), []);
  assert.equal(discoverPages(eEarphoneAdapter, `<script>${fixture}</script>`, firstPage), null);
});

test("e-earphone remains bounded and disabled pending seller consent, with safe partial coverage", () => {
  const plugin = getShopPlugin("e-earphone")!;
  assert.equal(getShopEnabled({}, plugin.definition), false);
  assert.equal(getShopEnabled({ E_EARPHONE_ENABLED: "false" }, plugin.definition), false);
  assert.equal(getShopMaxPages({}, plugin.definition, 40), 10);
  assert.equal(getShopRequestDelayMs({}, plugin.definition, 1200), 2000);
  assert.equal(plugin.definition.defaultIntervalMinutes, 720);
  assert.equal(plugin.definition.scheduleCron, undefined);
  assert.equal(
    coverageDecision(eEarphoneAdapter, {
      reachedEnd: true,
      coverageIncomplete: false,
      queueEmpty: true,
    }).deactivateMissing,
    false,
  );
  assert.equal(plugin.parse(fixture)[0].primaryCategoryId, "PER.HEADPHONE");
  // Relevant observed Shopify rules: never add a forbidden sorting/filter query to discovery.
  const robots = "User-agent: *\nDisallow: /collections/*sort_by*\nDisallow: /search\n";
  for (const page of [firstPage, ...discoverPages(eEarphoneAdapter, fixture, firstPage)!]) {
    assert.equal(isPathAllowed(robots, page.url), true);
  }
});
