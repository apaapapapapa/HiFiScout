import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  discoverTereonPageUrls,
  parseTereonListing,
  tereonAdapter,
} from "../src/crawler/shops/tereon.js";
import { initialPageQueue } from "../src/crawler/strategies.js";

const usedPage = {
  url: "https://www.tereon-tsuhan.com/shopbrand/004/X/",
  page: 1,
  conditionCode: "004" as const,
  conditionText: "中古品" as const,
};

const displayPage = {
  url: "https://www.tereon-tsuhan.com/shopbrand/003/X/",
  page: 1,
  conditionCode: "003" as const,
  conditionText: "展示品・開封品" as const,
};

test("Tereon parser canonicalizes contextual product URLs and extracts stable seller facts", () => {
  const html = `
    <table>
      <tr>
        <td><a href="/shopdetail/000000008111/004/X/page1/order/"><img src="/trx.jpg"></a></td>
        <td><a href="/shopdetail/000000008111/004/X/page1/order/">中古品：TRIODE TRX-1(真空管プリアンプ)</a></td>
        <td>TRIODE</td>
        <td>138,000円（税込）</td>
      </tr>
      <tr>
        <td><a href="/shopdetail/000000008112/004/X/page1/order/">中古品：B&W 702S3(BK)(元箱あり)</a></td>
        <td>B&W</td>
        <td>628,000円（税込）</td>
      </tr>
    </table>`;

  const items = parseTereonListing(html, usedPage);
  assert.equal(items.length, 2);
  assert.equal(items[0].sourceId, "000000008111");
  assert.equal(items[0].sourceUrl, "https://www.tereon-tsuhan.com/shopdetail/000000008111/");
  assert.equal(items[0].title, "TRIODE TRX-1(真空管プリアンプ)");
  assert.equal(items[0].manufacturer, "TRIODE");
  assert.equal(items[0].model, "TRX-1");
  assert.equal(items[0].category, "プリアンプ");
  assert.equal(items[0].conditionText, "中古品");
  assert.equal(items[0].priceYen, 138000);
  assert.equal(items[0].stockStatus, "in_stock");
  assert.deepEqual(items[0].metadata, { conditionCategoryCode: "004" });
  assert.equal(items[1].model, "702S3");
});

test("Tereon parser preserves item-level display and new-special conditions from category 003", () => {
  const html = `
    <div>
      <a href="/shopdetail/000000008201/003/X/page1/order/">展示品：Pioneer U-05(USB-DAC内蔵ヘッドホンアンプ)</a>
      Pioneer 74,700円（税込）
    </div>
    <div>
      <a href="/shopdetail/000000008202/003/X/page1/order/">新品特価：TAD TAD-E1TX</a>
      TAD 1,800,000円（税込）
    </div>`;

  const items = parseTereonListing(html, displayPage);
  assert.deepEqual(
    items.map(({ conditionText }) => conditionText),
    ["展示品", "新品特価"],
  );
  assert.equal(items[0].model, "U-05");
  assert.equal(items[0].category, "DAC");
  assert.equal(items[1].model, "TAD-E1TX");
});

test("Tereon parser marks explicit sold-out listings", () => {
  const html = `
    <div>
      <a href="/shopdetail/000000008301/004/X/page1/order/">中古品：STAX SR-L500MK2+SRM-500T(セット販売)</a>
      STAX 172,800円（税込） 売り切れ
    </div>`;

  const [item] = parseTereonListing(html, usedPage);
  assert.ok(item);
  assert.equal(item.stockStatus, "sold_out");
  assert.equal(item.model, "SR-L500MK2+SRM-500T");
});

test("Tereon pagination expands the result count while staying inside the selected category", () => {
  const html = `
    <div>全4件</div>
    <a href="/shopdetail/000000008401/004/X/page1/order/">中古品：LUXMAN C-10(プリアンプ)</a>
    <span>LUXMAN 100,000円（税込）</span>
    <a href="/shopdetail/000000008402/004/X/page1/order/">中古品：LUXMAN M-10(パワーアンプ)</a>
    <span>LUXMAN 200,000円（税込）</span>
    <a href="/shopbrand/003/X/page99/order/">別カテゴリ</a>`;

  assert.deepEqual(discoverTereonPageUrls(html, usedPage), [
    {
      ...usedPage,
      url: "https://www.tereon-tsuhan.com/shopbrand/004/X/page2/order/",
      page: 2,
    },
  ]);
});

test("Tereon pagination falls back to observed MakeShop page links when result count is absent", () => {
  const html = `
    <a href="/shopbrand/004/X/page2/order/">次</a>
    <a href="/shopbrand/003/X/page9/order/">別カテゴリ</a>`;

  assert.deepEqual(discoverTereonPageUrls(html, usedPage), [
    {
      ...usedPage,
      url: "https://www.tereon-tsuhan.com/shopbrand/004/X/page2/order/",
      page: 2,
    },
  ]);
});

test("Tereon adapter starts only from the requested used and display/open-box feeds", () => {
  assert.deepEqual(initialPageQueue(tereonAdapter, 10), [usedPage, displayPage]);
  assert.equal(tereonAdapter.discovery.coverage, "complete");
});
