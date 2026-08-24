import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
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

/**
 * The three shapes a Shimamusen listing title uses to say something that is not the product: the
 * brand written twice with the second spelling bracketed, a `※` delivery footnote, and a product
 * type fused to its qualifier. Each one had survived into the displayed model.
 */
test("Shimamusen listing prose never reaches the displayed model", () => {
  const html = `
    <ul>
      <li>
        <a href="/shopdetail/000000020101/036/Y/page1/order/">【特価品】Bowers&Wilkins(B&W) 802D4 B グロス・ブラック(ペア)</a>
        <span class="price">販売価格3,000,000円(税込)</span>
      </li>
      <li>
        <a href="/shopdetail/000000020102/ct826/page1/order/">【中古品】JBL D30085 HARTSFIELD(ペア) ※配達設置費・送料別途相談</a>
        <span class="price">販売価格2,000,000円(税込)</span>
      </li>
      <li>
        <a href="/shopdetail/000000020103/063/Y/page1/order/">【展示処分品】Western Electric 91E ブラック/ゴールド 真空管プリメインアンプ</a>
        <span class="price">販売価格1,500,000円(税込)</span>
      </li>
    </ul>`;

  const [bowers, jbl, western] = parseShimamusenListing(html, { kind: "中古品" }).map((item) =>
    normalizeCatalogProduct(item),
  );

  assert.equal(bowers.manufacturer, "Bowers & Wilkins");
  assert.equal(bowers.model, "802D4 B");
  assert.equal(jbl.manufacturer, "JBL");
  assert.equal(jbl.model, "D30085 HARTSFIELD(ペア)");
  assert.equal(western.manufacturer, "Western Electric");
  assert.equal(western.model, "91E");
});
