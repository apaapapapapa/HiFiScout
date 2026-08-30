import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  parseSoundSupportListing,
  soundSupportAdapter,
  type SoundSupportPage,
} from "../src/crawler/shops/sound-support.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { initialPageQueue } from "../src/crawler/strategies.js";

const listingHtml = `
<article>
  <a href="/31001.html">Mark Levinson No.5206</a>
  <p>新入荷</p>
  <p>定価：￥1,320,000（税込）</p>
  <p>価格：￥726,000（税込）</p>
  <p>程度：AA</p>
  <a href="/31001.html">&gt; 詳細を見る</a>
</article>
<article>
  <a href="https://sound-support.jp/31002.html">Accuphase C-3850</a>
  <p>定価：￥1,980,000（税込）</p>
  <p>価格：￥1,390,000（税込）</p>
  <p>程度：A</p>
  <p>売約済</p>
  <a href="/31002.html">&gt; 詳細を見る</a>
</article>
<a href="https://example.com/99999.html">External Product</a>`;

test("Sound Support listing parser extracts selling price instead of MSRP and preserves seller facts", () => {
  const page: SoundSupportPage = {
    url: "https://sound-support.jp/category/used/used-preamp",
    kind: "category",
    rawCategory: "プリアンプ",
  };
  const products = parseSoundSupportListing(listingHtml, page);

  assert.equal(products.length, 2);
  assert.deepEqual(
    {
      sourceId: products[0]?.sourceId,
      sourceUrl: products[0]?.sourceUrl,
      title: products[0]?.title,
      rawManufacturer: products[0]?.rawManufacturer,
      manufacturer: products[0]?.manufacturer,
      model: products[0]?.model,
      rawCategory: products[0]?.rawCategory,
      conditionText: products[0]?.conditionText,
      priceYen: products[0]?.priceYen,
      stockStatus: products[0]?.stockStatus,
    },
    {
      sourceId: "31001",
      sourceUrl: "https://sound-support.jp/31001.html",
      title: "Mark Levinson No.5206",
      rawManufacturer: "Mark Levinson",
      manufacturer: "Mark Levinson",
      model: "No.5206",
      rawCategory: "プリアンプ",
      conditionText: "程度 AA",
      priceYen: 726000,
      stockStatus: "in_stock",
    },
  );
  assert.deepEqual(products[0]?.metadata, {
    soundSupportCategory: "プリアンプ",
    categorySlug: "used-preamp",
  });

  assert.equal(products[1]?.priceYen, 1390000);
  assert.equal(products[1]?.stockStatus, "sold_out");
  assert.match(products[1]?.conditionText || "", /程度 A/u);
  assert.match(products[1]?.conditionText || "", /売約済/u);
});

test("Sound Support adapter crawls all inventory categories directly and follows the crawl rotation", () => {
  const targets = initialPageQueue(soundSupportAdapter, 20);
  assert.equal(targets.length, 10);
  assert.deepEqual(
    targets.map((page) => page.url),
    [
      "https://sound-support.jp/category/used/used-preamp",
      "https://sound-support.jp/category/used/used-poweramp",
      "https://sound-support.jp/category/used/used-premainamp",
      "https://sound-support.jp/category/used/used-speaker",
      "https://sound-support.jp/category/used/used-cdplayer",
      "https://sound-support.jp/category/used/used-daconverter",
      "https://sound-support.jp/category/used/used-analogfmtuner",
      "https://sound-support.jp/category/used/used-cable",
      "https://sound-support.jp/category/used/used-pcaudio",
      "https://sound-support.jp/category/used/used-etc",
    ],
  );
  assert.equal(soundSupportAdapter.discovery.coverage, "complete");
  assert.equal("discoverTargets" in soundSupportAdapter.discovery, false);

  const plugin = getShopPlugin("sound-support");
  assert.ok(plugin);
  assert.equal(plugin.definition.defaultIntervalMinutes, 140);
  assert.equal(plugin.definition.defaultMaxPages, 20);
  assert.equal(plugin.definition.envPrefix, "SOUND_SUPPORT");

  const categoryPage: SoundSupportPage = {
    url: "https://sound-support.jp/category/used/used-preamp",
    kind: "category",
    rawCategory: "プリアンプ",
  };
  const [normalized] = plugin.parse(listingHtml, categoryPage);
  assert.ok(normalized);
  assert.equal(normalized.primaryCategoryId, "AMP.PRE");
});
