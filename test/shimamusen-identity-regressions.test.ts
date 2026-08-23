import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { parseShimamusenListing } from "../src/crawler/shops/shimamusen.js";

test("Shimamusen promotional prefixes never become manufacturer or model identity", () => {
  const html = `
    <ul>
      <li>
        <a href="/shopdetail/000000017114/063/Y/page1/order/">【店頭在庫品処分セール】 Technics SL-1200M7B アナログプレーヤー</a>
        <span class="price">販売価格100,000円(税込)</span>
      </li>
      <li>
        <a href="/shopdetail/000000016325/036/Y/page1/order/">【期間限定特価】marantz Stereo 70s ネットワークオーディオレシーバー</a>
        <span class="price">販売価格120,000円(税込)</span>
      </li>
      <li>
        <a href="/shopdetail/000000018222/036/Y/page1/order/">【開封品】メーカー新装商品ELAC Debut ConneX DCB41 HDMI/Phono入力付アクティブスピーカー</a>
        <span class="price">販売価格80,000円(税込)</span>
      </li>
    </ul>`;

  const items = parseShimamusenListing(html, { kind: "特価商品" });
  assert.equal(items.length, 3);
  assert.equal(items[0].manufacturer, "Technics");
  assert.match(items[0].model, /^SL-1200M7B/u);
  assert.equal(items[1].manufacturer, "marantz");
  assert.match(items[1].model, /^Stereo 70s/u);
  assert.equal(items[2].manufacturer, "ELAC");
  assert.match(items[2].model, /^Debut ConneX DCB41/u);
});
