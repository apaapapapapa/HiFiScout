import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverShimamusenPageUrls,
  parseShimamusenListing,
  shimamusenAdapter,
} from "../src/crawler/shops/shimamusen.js";

const listingHtml = `
<ul class="item-list">
  <li>
    <a href="/shopdetail/000000019689/063/Y/page1/order/"><img src="/n01.jpg"></a>
    <a href="/shopdetail/000000019689/063/Y/page1/order/">〖展示処分品〗ESOTERIC N-01XD SE ネットワークプレーヤー</a>
    <span class="price">販売価格1,589,000円(税込)</span>
    <span class="maker">ESOTERIC</span>
  </li>
  <li>
    <a href="https://www.shimamusen.com/shopdetail/000000019645/036/Y/page1/order/">ARCAM A5 プリメインアンプ 〖新品在庫限り〗</a>
    <span class="price">販売価格77,000円(税込)</span>
    <span class="maker">ARCAM</span>
  </li>
  <li>
    <a href="/shopdetail/000000019600/036/Y/page1/order/">〖未使用開封品〗 Audio Replas SBT-4X4/HG-SIG 〖お取り寄せ〗</a>
    <span class="price">販売価格607,200円(税込)</span>
    <span class="maker">Audio Replas</span>
  </li>
</ul>`;

test("Shimamusen parser extracts products, price and listing kind", () => {
  const items = parseShimamusenListing(listingHtml, {
    url: "https://www.shimamusen.com/shopbrand/063/Y/",
    kind: "展示処分品",
  });
  assert.equal(items.length, 3);

  const display = items[0];
  assert.equal(display.sourceId, "000000019689");
  assert.equal(display.title, "〖展示処分品〗ESOTERIC N-01XD SE ネットワークプレーヤー");
  assert.equal(display.priceYen, 1589000);
  assert.equal(display.stockStatus, "in_stock");
  assert.equal(display.rawCategory, "展示処分品");
  assert.match(display.conditionText, /展示処分品/);
  assert.equal(
    display.sourceUrl,
    "https://www.shimamusen.com/shopdetail/000000019689/063/Y/page1/order/",
  );
});

test("Shimamusen parser de-duplicates image/title anchors for the same product", () => {
  const items = parseShimamusenListing(listingHtml, { kind: "特価商品" });
  assert.equal(items.filter((item) => item.sourceId === "000000019689").length, 1);
});

test("Shimamusen used pagination is discovered dynamically and sorted", () => {
  const html = `
    <a href="/shopbrand/ct826/page3/order/">3</a>
    <a href="/shopbrand/ct826/page2/order/">2</a>
    <a href="/shopbrand/ct826/page3/order/">次の50件</a>`;
  assert.deepEqual(discoverShimamusenPageUrls(html), [
    { url: "https://www.shimamusen.com/shopbrand/ct826/page2/order/", kind: "中古品" },
    { url: "https://www.shimamusen.com/shopbrand/ct826/page3/order/", kind: "中古品" },
  ]);
});

test("Shimamusen adapter starts from all three requested entry pages", () => {
  assert.deepEqual(
    [...shimamusenAdapter.pageUrls()],
    [
      { url: "https://www.shimamusen.com/shopbrand/063/Y/", kind: "展示処分品" },
      { url: "https://www.shimamusen.com/shopbrand/036/Y/", kind: "特価商品" },
      { url: "https://www.shimamusen.com/shopbrand/ct826/", kind: "中古品" },
    ],
  );
  assert.equal(shimamusenAdapter.dynamicPagination, true);
});
