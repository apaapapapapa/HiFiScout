import test from "node:test";
import assert from "node:assert/strict";
import { audioUnionAdapter } from "../src/crawler/shops/audiounion.js";

test("Audio Union uses only the allowed new-arrival used feed", () => {
  const urls = [...audioUnionAdapter.discovery.initialTargets({ maxPages: 40, env: {} })];
  assert.deepEqual(urls, ["https://www.audiounion.jp/st/new_arrival_used.html"]);
  assert.equal(audioUnionAdapter.discovery.coverage, "partial");
});

test("Audio Union treats a listing with a sales price as in stock", () => {
  const html = `
    <article>
      <div>中古</div>
      <a href="https://www.audiounion.jp/ct/detail/used/226086/">KEF LSX II サウンドウェーブ + P1 DeskPad ブラック</a>
      <div>販売価格: &yen;139,800</div>
    </article>`;
  const [item] = audioUnionAdapter.parse(
    html,
    "https://www.audiounion.jp/st/new_arrival_used.html",
  );
  assert.equal(item.sourceId, "226086");
  assert.equal(item.manufacturer, "KEF");
  assert.equal(item.rawManufacturer, "KEF");
  assert.equal(item.rawCategory, "");
  assert.equal(item.priceYen, 139800);
  assert.equal(item.stockStatus, "in_stock");
  assert.equal(item.conditionText, "中古");
  assert.equal(item.sourceUrl, "https://www.audiounion.jp/ct/detail/used/226086/");
});

test("Audio Union reconciles manufacturer and model candidates independent of link order", () => {
  const html = `
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300001/">LMC-5</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300001/">LUXMAN</a>
      <div>販売価格: &yen;138,000</div>
    </article>
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300002/">DENON</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300002/">DP-500M</a>
      <div>販売価格: &yen;45,800</div>
    </article>
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300003/">TD520RW 3012R</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300003/">Thorens</a>
      <div>販売価格: &yen;342,800</div>
    </article>`;

  const items = audioUnionAdapter.parse(html, "https://www.audiounion.jp/st/new_arrival_used.html");
  const luxman = items.find((item) => item.sourceId === "300001");
  const denon = items.find((item) => item.sourceId === "300002");
  const thorens = items.find((item) => item.sourceId === "300003");
  assert.ok(luxman);
  assert.ok(denon);
  assert.ok(thorens);

  assert.deepEqual(
    { manufacturer: luxman.manufacturer, model: luxman.model },
    { manufacturer: "LUXMAN", model: "LMC-5" },
  );
  assert.deepEqual(
    { manufacturer: denon.manufacturer, model: denon.model },
    { manufacturer: "DENON", model: "DP-500M" },
  );
  assert.deepEqual(
    { manufacturer: thorens.manufacturer, model: thorens.model },
    { manufacturer: "Thorens", model: "TD520RW 3012R" },
  );
  assert.equal(thorens.conditionText, "中古");
});

test("Audio Union handles multi-word manufacturers as full titles or split candidates", () => {
  const html = `
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300004/">mark</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300004/">Levinson</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300004/">No.326S</a>
      <div>販売価格: &yen;621,800</div>
    </article>
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300005/">Mark Levinson No.5805</a>
      <div>販売価格: &yen;395,800</div>
    </article>
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300006/">LINEAR</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300006/">TECHNOLOGY</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300006/">LT-1</a>
      <div>販売価格: &yen;198,000</div>
    </article>`;

  const items = audioUnionAdapter.parse(html, "https://www.audiounion.jp/st/new_arrival_used.html");
  const splitLinks = items.find((item) => item.sourceId === "300004");
  const fullTitle = items.find((item) => item.sourceId === "300005");
  const linear = items.find((item) => item.sourceId === "300006");
  assert.ok(splitLinks);
  assert.ok(fullTitle);
  assert.ok(linear);

  assert.deepEqual(
    { manufacturer: splitLinks.manufacturer, model: splitLinks.model },
    { manufacturer: "mark Levinson", model: "No.326S" },
  );
  assert.deepEqual(
    { manufacturer: fullTitle.manufacturer, model: fullTitle.model },
    { manufacturer: "Mark Levinson", model: "No.5805" },
  );
  assert.deepEqual(
    { manufacturer: linear.manufacturer, model: linear.model },
    { manufacturer: "LINEAR TECHNOLOGY", model: "LT-1" },
  );
});

test("Audio Union preserves uncatalogued manufacturers containing digits when detail repeats the prefix", () => {
  const html = `
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300007/">3D Lab</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300007/">3D Lab Nano Network Player</a>
      <div>販売価格: &yen;248,000</div>
    </article>`;

  const [item] = audioUnionAdapter.parse(
    html,
    "https://www.audiounion.jp/st/new_arrival_used.html",
  );
  assert.equal(item.manufacturer, "3D Lab");
  assert.equal(item.model, "Nano Network Player");
});

test("Audio Union prefers the richer duplicate link and current product price", () => {
  const html = `
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/226086/">KEF</a>
      <a href="https://www.audiounion.jp/ct/detail/used/226086/">KEF LSX II サウンドウェーブ + P1 DeskPad ブラック</a>
      <div>販売価格: &yen;139,800</div>
    </article>
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/225940/">dCS</a>
      <a href="https://www.audiounion.jp/ct/detail/used/225940/">dCS Bartok DAC+ (with Headphone Amplifier)</a>
      <div>販売価格: &yen;1,798,000</div>
    </article>`;
  const items = audioUnionAdapter.parse(html, "https://www.audiounion.jp/st/new_arrival_used.html");
  const dcs = items.find((item) => item.sourceId === "225940");
  assert.ok(dcs);
  assert.equal(dcs.manufacturer, "dCS");
  assert.equal(dcs.model, "Bartok DAC+ (with Headphone Amplifier)");
  assert.equal(dcs.priceYen, 1798000);
  assert.equal(dcs.stockStatus, "in_stock");
});

test("Audio Union trims SEO sales copy from an uncatalogued manufacturer model", () => {
  const html = `
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300008/">MAGICO</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300008/">中古 MAGICO スピーカーシステム A1 A1 販売店: オーディオユニオン 大阪店 MAGICO A1 スピーカーシステム 販売価格:</a>
      <div>販売価格: &yen;1,180,000</div>
    </article>`;

  const [item] = audioUnionAdapter.parse(
    html,
    "https://www.audiounion.jp/st/new_arrival_used.html",
  );
  assert.equal(item.manufacturer, "MAGICO");
  assert.equal(item.model, "A1");
  assert.equal(item.title, "MAGICO A1");
});

test("Audio Union keeps an uncatalogued multi-word brand together", () => {
  const html = `
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/300009/">Austrian</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300009/">Audio</a>
      <a href="https://www.audiounion.jp/ct/detail/used/300009/">The Composer</a>
      <div>販売価格: &yen;328,000</div>
    </article>`;

  const [item] = audioUnionAdapter.parse(
    html,
    "https://www.audiounion.jp/st/new_arrival_used.html",
  );
  assert.equal(item.manufacturer, "Austrian Audio");
  assert.equal(item.model, "The Composer");
  assert.equal(item.title, "Austrian Audio The Composer");
});
