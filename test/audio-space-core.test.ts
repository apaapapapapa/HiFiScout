import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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

test("Audio Space Core parser keeps current inventory and ignores sold history", () => {
  const items = parseAudioSpaceCoreListing(html);
  assert.equal(items.length, 3);

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

  assert.equal(
    items.some((item) => item.model === "CL310JET"),
    false,
  );

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

test("Audio Space Core baseline reset migration works with an existing sync-state row", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`
      CREATE TABLE shop_sync_state (
        shop_key TEXT PRIMARY KEY,
        last_item_count INTEGER NOT NULL
      );
      INSERT INTO shop_sync_state (shop_key, last_item_count)
      VALUES ('audio-space-core', 1200);
    `);

    const migration = readFileSync(
      new URL("../migrations/0049_reset_audio_space_core_item_baseline.sql", import.meta.url),
      "utf8",
    );
    sqlite.exec(migration);

    const row = sqlite
      .prepare("SELECT last_item_count FROM shop_sync_state WHERE shop_key = 'audio-space-core'")
      .get() as { last_item_count: number };
    assert.equal(row.last_item_count, 0);
  } finally {
    sqlite.close();
  }
});
