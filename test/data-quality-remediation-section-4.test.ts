import { test } from "vitest";
import assert from "node:assert/strict";

import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import { extractFujiyaDetailCategoryEvidence } from "../src/crawler/shops/fujiya-avic.js";
import { parseHifidoListing } from "../src/crawler/shops/hifido.js";

function category(title: string): string | undefined {
  return inferExplicitCategoryIds(title, { context: "title" })[0];
}

test("E-1 wireless earphone model families do not fall through to wired earphone", () => {
  for (const title of [
    "SONY WF-1000XM5/BC",
    "SONY WF-1000XM6 BZ",
    "BOSE QuietComfort Ultra Earbuds",
    "JBL TOUR PRO 3",
    "Shokz OpenFit2+",
    "Shokz OpenDots ONE",
    "Shokz OpenRun Pro 2",
    "Apple AirPods Pro 3",
    "HUAWEI FreeBuds Pro 4",
    "SONY LinkBuds Fit",
  ]) {
    assert.equal(category(title), "btw_earphone", title);
  }

  assert.equal(category("SENNHEISER IE 600 Earphones"), "wired_earphone");
});

test("E-1 wireless headphone model families classify before wired headphone", () => {
  for (const title of [
    "SONY WH-1000XM6 BM",
    "SONY WI-1000XM2",
    "BOSE QuietComfort Ultra Headphones",
    "B&W Px7 S3",
    "SENNHEISER MOMENTUM 4 Wireless",
    "Apple AirPods Max",
  ]) {
    assert.equal(category(title), "btw_headphone", title);
  }

  assert.equal(category("Apple AirPods Pro 3"), "btw_earphone");
  assert.equal(category("Apple AirPods Max"), "btw_headphone");
});

test("E-2 Fujiya detail evidence does not turn a non-cable product into cable_other", () => {
  const evidence = extractFujiyaDetailCategoryEvidence(
    '<html><head><meta name="description" content="MAGNETAR UDP900には電源ケーブルが付属します。高品位なユニバーサルディスクプレーヤーです。"></head></html>',
    { model: "UDP900", title: "MAGNETAR UDP900 [MGT-UDP900]" },
  );
  assert.deepEqual(evidence, []);
});

test("E-2 Fujiya detail evidence still accepts cable evidence for a listing that declares cable", () => {
  const evidence = extractFujiyaDetailCategoryEvidence(
    '<html><head><meta name="description" content="ACME POWER CABLE 1.0mは電源ケーブルです。"></head></html>',
    { model: "POWER CABLE 1.0m", title: "ACME POWER CABLE 1.0m" },
  );
  assert.deepEqual(
    evidence.map((item) => item.categoryIds),
    [["cable_power"]],
  );
});

test("E-2 Fujiya detail evidence ignores category words in unrelated sentences", () => {
  const evidence = extractFujiyaDetailCategoryEvidence(
    '<html><head><meta name="description" content="Victor DLA-V50-Bの中古商品です。接続にはHDMIケーブルがおすすめです。"></head></html>',
    { model: "DLA-V50-B", title: "Victor DLA-V50-B" },
  );
  assert.deepEqual(evidence, []);
});

test("E-3 Hifido reads the structural genre field rather than unrelated free text", () => {
  const html = `
    <div class="list-item">
      <h3><a href="/26-50215-14039-00.html?LNG=J" id="type-26-50215-14039-00">MC240</a></h3>
      <div id="maker-26-50215-14039-00"><div>メーカー:<a href="/?KW=McIntosh">McIntosh</a></div></div>
      <div id="price-26-50215-14039-00"><div>売価:498,000円(税込)</div></div>
      <div id="genre-26-50215-14039-00"><div>パワーアンプ（真空管）</div></div>
      <p>オーディオラックへの設置時は放熱スペースを確保してください。</p>
    </div>`;

  const [product] = parseHifidoListing(html);
  assert.equal(product.rawCategory, "パワーアンプ");
  assert.equal(product.category, "パワーアンプ");
});

test("N-1 Hifido excludes an LP box set before category inference", () => {
  const html = `
    <div class="list-item">
      <h3><a href="/26-50001-10001-00.html?LNG=J" id="type-26-50001-10001-00">クラシックLP 10枚セット</a></h3>
      <div id="maker-26-50001-10001-00"><div>メーカー:その他</div></div>
      <div id="price-26-50001-10001-00"><div>売価:5,000円(税込)</div></div>
      <p>カートリッジ交換後の試聴にもおすすめのレコードセットです。</p>
    </div>`;

  assert.deepEqual(parseHifidoListing(html), []);
});

test("E-4 Hifido rack mentions cannot override an explicit seller genre", () => {
  const html = `
    <div class="list-item">
      <h3><a href="/26-50002-10002-00.html?LNG=J" id="type-26-50002-10002-00">JPC-100/1.0m</a></h3>
      <div id="maker-26-50002-10002-00"><div>メーカー:JPC</div></div>
      <div id="price-26-50002-10002-00"><div>売価:10,000円(税込)</div></div>
      <div id="genre-26-50002-10002-00"><div>ケーブル</div></div>
      <p>ラック内でも取り回しやすい設計です。</p>
    </div>`;

  const [product] = parseHifidoListing(html);
  assert.equal(product.rawCategory, "ケーブル");
  assert.notEqual(product.rawCategory, "ラック");
});
