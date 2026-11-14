import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  discoverDynamicAudioPageUrls,
  dynamicAudioAdapter,
  parseDynamicAudioListing,
} from "../src/crawler/shops/dynamic-audio.js";
import { initialPageQueue } from "../src/crawler/strategies.js";

const fixture = await readFile(
  new URL("./fixtures/dynamic-audio/list.html", import.meta.url),
  "utf8",
);

test("Dynamic Audio parser extracts current prices and seller facts", () => {
  const items = parseDynamicAudioListing(fixture);
  assert.equal(items.length, 3);

  const luxman = items.find((item) => item.sourceId === "101");
  assert.ok(luxman);
  assert.equal(luxman.title, "LUXMAN D-08u");
  assert.equal(luxman.manufacturer, "LUXMAN");
  assert.equal(luxman.model, "D-08u");
  assert.equal(luxman.rawCategory, "SACD/CDプレーヤー");
  assert.equal(luxman.priceYen, 550000);
  assert.equal(luxman.stockStatus, "in_stock");
  assert.equal(luxman.sourcePublishedAt, "2026-07-11T15:00:00.000Z");
  assert.equal(luxman.metadata?.sourcePublishedPrecision, "day");
  assert.match(luxman.conditionText, /中古/);
  assert.match(luxman.conditionText, /A−/);
  assert.match(luxman.conditionText, /商談中/);
  assert.equal(luxman.metadata?.accessories, "電源ケーブル・リモコン・説明書");
});

test("Dynamic Audio parser maps explicit sold markers to sold_out", () => {
  const sold = parseDynamicAudioListing(fixture).find((item) => item.sourceId === "102");
  assert.ok(sold);
  assert.equal(sold.stockStatus, "sold_out");
  assert.equal(sold.priceYen, null);
  assert.equal(sold.rawCategory, "パワーアンプ");
});

test("Dynamic Audio parser uses the final advertised price after an arrow", () => {
  const discounted = parseDynamicAudioListing(fixture).find((item) => item.sourceId === "103");
  assert.ok(discounted);
  assert.equal(discounted.priceYen, 620000);
  assert.equal(discounted.manufacturer, "Mark Levinson");
  assert.equal(discounted.model, "No5302");
});

test("Dynamic Audio parser ignores editorial sale posts without a product classification", () => {
  assert.equal(
    parseDynamicAudioListing(fixture).some((item) => item.sourceId === "104"),
    false,
  );
});

// Raw-text payloads must never become seller facts, even when closing-tag syntax is irregular.
test("Dynamic Audio parser strips raw-text content despite malformed closing-tag suffixes", () => {
  const html = `
    <article id="post-105" class="post type-post">
      <h2 class="entry-title"><a href="/2026/08/19/luxman-d-10x/">LUXMAN D-10X</a></h2>
      <div class="entry-content">
        <p>中古＠SACD/CDプレーヤー<br>販売価格 ￥900,000</p>
        <script data-test=">">販売価格 ￥1,111,111</script\t\n ignored>
        <style>販売価格 ￥2,222,222</style\n ignored>
      </div>
    </article>
  `;
  const [item] = parseDynamicAudioListing(html);
  assert.ok(item);
  assert.equal(item.priceYen, 900000);
});

test("Dynamic Audio pagination is discovered on the WordPress archive", () => {
  assert.deepEqual(discoverDynamicAudioPageUrls(fixture, 1), [
    { url: "https://dynamicaudio5used.wordpress.com/page/2/", page: 2 },
    { url: "https://dynamicaudio5used.wordpress.com/page/3/", page: 3 },
  ]);
  assert.deepEqual(discoverDynamicAudioPageUrls(fixture, 2), [
    { url: "https://dynamicaudio5used.wordpress.com/page/3/", page: 3 },
  ]);
});

test("Dynamic Audio adapter starts from the archive root with non-destructive coverage", () => {
  assert.deepEqual(initialPageQueue(dynamicAudioAdapter, 30), [
    { url: "https://dynamicaudio5used.wordpress.com/", page: 1 },
  ]);
  assert.equal(dynamicAudioAdapter.discovery.coverage, "partial");
});

test("Dynamic Audio accepts only an explicit published datetime in the same article header", () => {
  const html = `
    <article id="post-105" class="post type-post">
      <header class="entry-header">
        <h2 class="entry-title"><a href="/2026/08/19/luxman-d-10x/">LUXMAN D-10X</a></h2>
        <time class="entry-date published" datetime="2026-08-19T17:42:07+09:00">8月19日</time>
        <time class="updated" datetime="2026-11-11T09:30:00+09:00">更新</time>
      </header>
      <div class="entry-content"><p>中古＠SACD/CDプレーヤー<br>販売価格 ￥900,000</p></div>
    </article>
  `;
  const [item] = parseDynamicAudioListing(html);
  assert.equal(item.sourcePublishedAt, "2026-08-19T08:42:07.000Z");
  assert.equal(item.metadata?.sourcePublishedPrecision, "second");
  const changedDate = html.replace("2026-08-19T17:42:07+09:00", "2026-08-20T17:42:07+09:00");
  const [fallback] = parseDynamicAudioListing(changedDate);
  assert.equal(fallback.sourcePublishedAt, "2026-08-18T15:00:00.000Z");
  assert.equal(fallback.metadata?.sourcePublishedPrecision, "day");

  const prependUpdated = html.replace(
    '<time class="entry-date published"',
    '<time class="updated" datetime="2026-08-20T17:42:07+09:00">更新</time>\n        <time class="entry-date published"',
  );
  const [kept] = parseDynamicAudioListing(prependUpdated);
  assert.equal(kept.sourcePublishedAt, "2026-08-19T08:42:07.000Z");
  assert.equal(kept.metadata?.sourcePublishedPrecision, "second");

  const wrongPublishedDate = prependUpdated
    .replace(
      'class="entry-date published" datetime="2026-08-19T17:42:07+09:00"',
      'class="entry-date published" datetime="2026-08-20T17:42:07+09:00"',
    )
    .replace(
      'class="updated" datetime="2026-08-20T17:42:07+09:00"',
      'class="updated" datetime="2026-08-19T17:42:07+09:00"',
    );
  const [dateFallback] = parseDynamicAudioListing(wrongPublishedDate);
  assert.equal(dateFallback.sourcePublishedAt, "2026-08-18T15:00:00.000Z");
  assert.equal(dateFallback.metadata?.sourcePublishedPrecision, "day");
});
