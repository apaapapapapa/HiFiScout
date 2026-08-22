import assert from "node:assert/strict";
import test from "node:test";

import { resolveModel } from "../src/catalog/model-resolver.js";
import { parseShimamusenListing } from "../src/crawler/shops/shimamusen.js";
import { parseUAudioListing } from "../src/crawler/shops/u-audio.js";

test("model resolution removes audited seller notes without changing raw evidence", () => {
  const shipping = resolveModel({
    rawModel: "E-700 ※送料無料",
    manufacturerId: "accuphase",
    title: "Accuphase E-700 ※送料無料",
  });
  assert.equal(shipping.rawModel, "E-700 ※送料無料");
  assert.equal(shipping.model, "E-700");
  assert.equal(shipping.status, "resolved");
  assert.deepEqual(shipping.removedAnnotations, ["shipping"]);

  const bStock = resolveModel({
    rawModel: "MODEL 30 B級品",
    manufacturerId: "marantz",
    title: "Marantz MODEL 30 B級品",
  });
  assert.equal(bStock.model, "MODEL 30");
  assert.equal(bStock.status, "resolved");
  assert.ok(bStock.removedAnnotations.includes("condition"));
});

test("Shimamusen identity ignores listing badges and circled listing indexes", () => {
  const html = `
    <a href="/shopdetail/000000020001/ct826/Y/page1/order/">
      【中古品】①Accuphase ASLC-10 XLRケーブル/1.0m(ペア）※送料無料
    </a>
    <span class="price">販売価格88,000円(税込)</span>`;
  const [item] = parseShimamusenListing(html, { kind: "中古品" });
  assert.ok(item);
  assert.equal(item.manufacturer, "Accuphase");
  assert.match(item.model, /^ASLC-10/u);
});

test("U-AUDIO sale notes stay in condition evidence instead of manufacturer identity", () => {
  const html = `
    <p>全 1 件</p>
    <a href="/view/item/000000009999">No.5206 / Mark Levinson 訳あり特価</a>
    商品コード 99999 販売価格（税込） ￥980,000 カートに入れる`;
  const [item] = parseUAudioListing(html, { rawCategory: "中古プリアンプ" });
  assert.ok(item);
  assert.equal(item.manufacturer, "Mark Levinson");
  assert.equal(item.model, "No.5206");
  assert.match(item.conditionText, /訳あり特価/u);
});
