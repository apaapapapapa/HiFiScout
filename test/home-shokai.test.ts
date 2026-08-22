import test from "node:test";
import assert from "node:assert/strict";
import {
  homeShokaiAdapter,
  parseHomeShokaiListing,
  type HomeShokaiPage,
} from "../src/crawler/shops/home-shokai.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { initialPageQueue } from "../src/crawler/strategies.js";

const consignmentHtml = `
<section>
  <a href="item.php?z=1001">MARK LEVINSON プリアンプ JC-2 〇委託販売品 ￥ 310,000 -</a>
  <a href="/item.php?z=1002">TELEFUNKEN スピーカーシステム KLANGBOX WB60ペア 〇委託販売品 ￥ 88,000 -</a>
  <a href="/item.php?z=1003">JOB プリアンプ + パワーアンプ PRE2 + 225 〇委託販売品 ￥ 298,000 -</a>
  <a href="/item.php?z=1004">商談中 McIntosh 真空管プリアンプ C22 Original Edition 〇委託販売品 ￥ 578,000 -</a>
  <a href="https://example.com/item.php?z=9999">External Product 〇委託販売品 ￥ 1,000 -</a>
</section>`;

const specialHtml = `
<section>
  <a href="/item.php?z=2001">MARK LEVINSON レコードプレーヤー No.5105 〇特価品 ￥ 680,000 -</a>
  <a href="/item.php?z=2002">DENON SACD/CDプレーヤー DCD-3000NE 〇特価品 ￥ 297,000 -</a>
  <a href="/item.php?z=2003">DENON プリメインアンプ PMA-3000NE 〇特価品 ￥ 356,400 -</a>
</section>`;

const consignmentPage: HomeShokaiPage = {
  url: "https://www.homeshokai.jp/itemlist.php?a=2",
  kind: "listing",
  listingType: "consignment",
};

const specialPage: HomeShokaiPage = {
  url: "https://www.homeshokai.jp/itemlist.php?a=3",
  kind: "listing",
  listingType: "special",
};

test("Home Shokai parser extracts consignment facts and handles multi-word manufacturers", () => {
  const products = parseHomeShokaiListing(consignmentHtml, consignmentPage);
  assert.equal(products.length, 4);

  assert.deepEqual(
    {
      sourceId: products[0]?.sourceId,
      sourceUrl: products[0]?.sourceUrl,
      title: products[0]?.title,
      manufacturer: products[0]?.manufacturer,
      model: products[0]?.model,
      rawCategory: products[0]?.rawCategory,
      priceYen: products[0]?.priceYen,
      stockStatus: products[0]?.stockStatus,
      metadata: products[0]?.metadata,
    },
    {
      sourceId: "1001",
      sourceUrl: "https://www.homeshokai.jp/item.php?z=1001",
      title: "MARK LEVINSON JC-2",
      manufacturer: "MARK LEVINSON",
      model: "JC-2",
      rawCategory: "プリアンプ",
      priceYen: 310000,
      stockStatus: "in_stock",
      metadata: {
        homeShokaiListingType: "委託販売品",
        listingUrl: "https://www.homeshokai.jp/itemlist.php?a=2",
      },
    },
  );

  assert.equal(products[1]?.manufacturer, "TELEFUNKEN");
  assert.equal(products[1]?.model, "KLANGBOX WB60ペア");
  assert.equal(products[1]?.rawCategory, "スピーカーシステム");
  assert.equal(products[2]?.manufacturer, "JOB");
  assert.equal(products[2]?.model, "PRE2 + 225");
  assert.equal(products[2]?.rawCategory, "プリアンプ + パワーアンプ");
  assert.equal(products[3]?.manufacturer, "McIntosh");
  assert.equal(products[3]?.model, "C22 Original Edition");
  assert.equal(products[3]?.rawCategory, "真空管プリアンプ");
  assert.equal(products[3]?.stockStatus, "unknown");
  assert.match(products[3]?.conditionText || "", /商談中/u);
});

test("Home Shokai parser extracts special-price products without mistaking category text for model", () => {
  const products = parseHomeShokaiListing(specialHtml, specialPage);
  assert.equal(products.length, 3);

  assert.equal(products[0]?.manufacturer, "MARK LEVINSON");
  assert.equal(products[0]?.model, "No.5105");
  assert.equal(products[0]?.rawCategory, "レコードプレーヤー");
  assert.equal(products[0]?.priceYen, 680000);
  assert.equal(products[1]?.model, "DCD-3000NE");
  assert.equal(products[1]?.rawCategory, "SACD/CDプレーヤー");
  assert.equal(products[2]?.model, "PMA-3000NE");
  assert.equal(products[2]?.priceYen, 356400);
});

test("Home Shokai adapter covers the two requested inventory snapshots and is registered hourly", () => {
  const targets = initialPageQueue(homeShokaiAdapter, 10);
  assert.deepEqual(
    targets.map((page) => page.url),
    ["https://www.homeshokai.jp/itemlist.php?a=2", "https://www.homeshokai.jp/itemlist.php?a=3"],
  );
  assert.equal(homeShokaiAdapter.discovery.coverage, "complete");
  assert.equal("discoverTargets" in homeShokaiAdapter.discovery, false);

  const plugin = getShopPlugin("home-shokai");
  assert.ok(plugin);
  assert.equal(plugin.definition.defaultIntervalMinutes, 60);
  assert.equal(plugin.definition.defaultMaxPages, 2);
  assert.equal(plugin.definition.envPrefix, "HOME_SHOKAI");

  const [normalizedPreamp] = plugin.parse(consignmentHtml, consignmentPage);
  assert.ok(normalizedPreamp);
  assert.equal(normalizedPreamp.primaryCategoryId, "pre_amp");

  const [normalizedTurntable] = plugin.parse(specialHtml, specialPage);
  assert.ok(normalizedTurntable);
  assert.equal(normalizedTurntable.primaryCategoryId, "turntable");
});
