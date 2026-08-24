import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { parseProductPage } from "../src/crawler/parser.js";

test("parses JSON-LD without copying description or image", () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"LUXMAN - D-10X《JP-u》","url":"/shopdetail/USED-1","image":"/copyrighted.jpg","description":"do not store","offers":{"price":"780000","availability":"https://schema.org/InStock"}}</script>`;
  const [item] = parseProductPage(html, {
    shopKey: "ippinkan",
    baseUrl: "https://ippinkan.jp",
    productUrlPattern: /shopdetail/,
  });
  assert.equal(item.manufacturer, "LUXMAN");
  assert.equal(item.priceYen, 780000);
  assert.equal(item.stockStatus, "in_stock");
  assert.equal("image" in item, false);
  assert.equal("description" in item, false);
});

test("JSON-LD is read from every end tag a browser accepts, and from script tags only", () => {
  const product = `{"@type":"Product","name":"LUXMAN - D-10X《JP-u》","url":"/shopdetail/USED-1","offers":{"price":"780000","availability":"https://schema.org/InStock"}}`;
  const options = {
    shopKey: "ippinkan",
    baseUrl: "https://ippinkan.jp",
    productUrlPattern: /shopdetail/,
  };

  // A block closed this way is still one block to a browser. Missing it drops the seller's own
  // structured facts and leaves the crawler guessing the product from surrounding markup.
  for (const closing of ["</script>", "</script >", `</script${"\t\n      data-extra"}>`]) {
    const [item] = parseProductPage(
      `<script type="application/ld+json">${product}${closing}`,
      options,
    );
    assert.equal(item?.priceYen, 780000, closing);
  }

  // `script-x` is a different tag name, so its contents are not the page's JSON-LD.
  assert.deepEqual(
    parseProductPage(`<script-x type="application/ld+json">${product}</script-x>`, options),
    [],
  );

  // A no-break space is whitespace to JavaScript's `\s` but not to an HTML tokenizer. Ending the
  // block there would hand `JSON.parse` a truncated document and discard the product entirely.
  const withNoBreakSpace = product.replace('"name":"', `"note":"</script\u00a0>","name":"`);
  const [item] = parseProductPage(
    `<script type="application/ld+json">${withNoBreakSpace}</script>`,
    options,
  );
  assert.equal(item?.priceYen, 780000);
});

test("Ippinkan listing condition marker is retained as factual metadata but removed from model", () => {
  const html = `<a href="/shopdetail/000000027559/U100000/page1/order/">TAD - E2-WN/ウォルナット『展示機』（ペア）《JP-u》</a><span>980,000円（税込）</span>`;
  const [item] = parseProductPage(html, {
    shopKey: "ippinkan",
    baseUrl: "https://ippinkan.jp/shopbrand/U100000/",
    productUrlPattern: /ippinkan\.jp\/(?:shopdetail|view\/item|shop\/products?)/i,
  });
  assert.equal(item.manufacturer, "TAD");
  assert.equal(item.model, "E2-WN/ウォルナット（ペア）");
  assert.equal(item.conditionText, "展示機");
  assert.equal(item.priceYen, 980000);
});
