import { test } from "vitest";
import assert from "node:assert/strict";

import {
  audioSpaceCoreAdapter,
  parseAudioSpaceCoreListing,
} from "../src/crawler/shops/audio-space-core.js";
import { discoverPages, initialPageQueue } from "../src/crawler/strategies.js";

const html = `
<h3>スピーカー（ペア）</h3>
<table>
  <tr><th></th><th>型番</th><th>品名</th><th>メーカー</th><th>定価（税込）</th><th>販売価格（税込）</th></tr>
  <tr>
    <td>最終値下げ！極上！！</td>
    <td><a href="/CHEVIOT">CHEVIOT</a></td>
    <td></td>
    <td>タンノイ</td>
    <td>￥1,254,000</td>
    <td>￥598,000</td>
  </tr>
  <tr>
    <td>商談中</td>
    <td><a href="/MERCURY7.4">MERCURY7.4</a></td>
    <td></td>
    <td>タンノイ</td>
    <td>￥110,000</td>
    <td>￥48,000</td>
  </tr>
  <tr>
    <td></td>
    <td><a href="/CL310JETb">CL310JET</a></td>
    <td></td>
    <td>ELAC</td>
    <td>￥231000</td>
    <td>売約済み</td>
  </tr>
  <tr>
    <td></td>
    <td><a href="/CL310JETc">CL310JET</a></td>
    <td></td>
    <td>ELAC</td>
    <td>￥189000</td>
    <td>売約済み</td>
  </tr>
</table>
<h3>D/Aコンバーター関連（DAC）</h3>
<table>
  <tr>
    <td>お薦め！！</td>
    <td><a href="https://as-core.co.jp/ElgarPlus1394">ElgarPlus1394</a></td>
    <td>D/Aコンバーター</td>
    <td>dCS</td>
    <td>￥2,184,000</td>
    <td>￥698,000</td>
  </tr>
</table>`;

test("Audio Space Core parser preserves seller facts and unique detail ids", () => {
  const items = parseAudioSpaceCoreListing(html);
  assert.equal(items.length, 5);

  const cheviot = items.find((item) => item.model === "CHEVIOT");
  assert.ok(cheviot);
  assert.equal(cheviot.sourceId, "/CHEVIOT");
  assert.equal(cheviot.sourceUrl, "https://www.as-core.co.jp/CHEVIOT");
  assert.equal(cheviot.manufacturer, "タンノイ");
  assert.equal(cheviot.rawManufacturer, "タンノイ");
  assert.equal(cheviot.rawCategory, "スピーカー（ペア）");
  assert.equal(cheviot.category, "スピーカー");
  assert.equal(cheviot.priceYen, 598000);
  assert.equal(cheviot.stockStatus, "in_stock");
  assert.match(cheviot.conditionText, /最終値下げ！極上！！/u);

  const negotiating = items.find((item) => item.model === "MERCURY7.4");
  assert.ok(negotiating);
  assert.equal(negotiating.priceYen, 48000);
  assert.equal(negotiating.stockStatus, "unknown");
  assert.match(negotiating.conditionText, /商談中/u);

  const duplicateModels = items.filter((item) => item.model === "CL310JET");
  assert.deepEqual(duplicateModels.map((item) => item.sourceId).sort(), [
    "/CL310JETb",
    "/CL310JETc",
  ]);
  assert.ok(duplicateModels.every((item) => item.stockStatus === "sold_out"));
  assert.ok(duplicateModels.every((item) => item.priceYen === null));

  const dac = items.find((item) => item.model === "ElgarPlus1394");
  assert.ok(dac);
  assert.equal(dac.sourceUrl, "https://www.as-core.co.jp/ElgarPlus1394");
  assert.equal(dac.rawCategory, "D/Aコンバーター関連（DAC）");
  assert.equal(dac.category, "DAC");
  assert.equal(dac.priceYen, 698000);
});

test("Audio Space Core adapter declares the used page as one complete storefront snapshot", () => {
  assert.deepEqual(initialPageQueue(audioSpaceCoreAdapter, 40), ["https://www.as-core.co.jp/used"]);
  assert.equal(audioSpaceCoreAdapter.discovery.coverage, "complete");
  assert.deepEqual(discoverPages(audioSpaceCoreAdapter, "", "https://www.as-core.co.jp/used"), []);
});
