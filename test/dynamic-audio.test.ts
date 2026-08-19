import test from "node:test";
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
