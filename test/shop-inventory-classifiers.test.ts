import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  classifyFujiyaAvicInventoryPage,
  isFujiyaAvicDetailUrl,
} from "../src/crawler/shops/fujiya-avic-inventory.js";
import {
  classifyHifidoInventoryPage,
  isHifidoDetailUrl,
} from "../src/crawler/shops/hifido-inventory.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";

const HIFIDO_ID = "26-50529-16848-00";
const HIFIDO_URL = `https://www.hifido.co.jp/${HIFIDO_ID}.html?LNG=J`;

// Structural selectors observed on Hifido product and sold pages, with minimal synthetic content.
function hifidoCard({
  id = HIFIDO_ID,
  price = "売価:24,800円(税込)",
  orderButton = true,
  comment = "",
}: { id?: string; price?: string; orderButton?: boolean; comment?: string } = {}) {
  return `<html><body><div class="menu-right2"><div id="tag_cart_list">カートは空です</div></div>
    <div class="list-item-for-detail">
      <div class="list-item-top"><div class="list-title">
        <h3><a href="/${id}.html?LNG=J" id="type-${id}">BW001-PRO</a></h3>
        <img id="status" src="/photo/img/x.gif">
        ${orderButton ? `<input type="hidden" name="code" id="code-${id}" value="1"><button class="btn1 order_button" id="${id}" lang=":">注文</button>` : ""}
        <a href="#inquiry" class="btn1 inquiry modal-inquiry">質問</a>
      </div></div>
      <div class="list-item-middle"><div class="list-item-middle-left-detail">
        <div id="price-${id}" style="font-weight:bold;"><div>${price}</div></div>
      </div></div>
      <div class="list-item-bottom"><div class="list-comment" id="jfeature-${id}">${comment}</div></div>
    </div>
    <a href="/sold/">過去情報データベース</a></body></html>`;
}

test("Hifido recheck accepts only exact product URLs", () => {
  assert.equal(isHifidoDetailUrl(HIFIDO_URL), true);
  assert.equal(isHifidoDetailUrl(`https://www.hifido.co.jp/${HIFIDO_ID}.html`), true);
  for (const value of [
    `http://www.hifido.co.jp/${HIFIDO_ID}.html?LNG=J`,
    `https://www.hifido.co.jp/sold/${HIFIDO_ID}.html`,
    `https://www.hifido.co.jp/${HIFIDO_ID}.html?LNG=E`,
    `https://www.hifido.co.jp/${HIFIDO_ID}.html?LNG=J#x`,
    `https://hifido.co.jp/${HIFIDO_ID}.html`,
    "https://www.hifido.co.jp/?L=50&LNG=J&O=0&OD=0",
  ])
    assert.equal(isHifidoDetailUrl(value), false, value);
  const policy = getShopPlugin("hifido")?.capabilities.inventoryRecheck;
  assert.ok(policy?.isDetailUrl(HIFIDO_URL));
});

test("Hifido detail availability follows the listing's own order button and price field", () => {
  const listing = { sourceUrl: HIFIDO_URL };
  assert.equal(classifyHifidoInventoryPage(hifidoCard(), listing), "in_stock");
  assert.equal(
    classifyHifidoInventoryPage(
      hifidoCard({ price: "売価:24,800円(税込)売約済み", orderButton: false }),
      listing,
    ),
    "sold_out",
  );
  // Neither signal: unknown, never sold.
  assert.equal(classifyHifidoInventoryPage(hifidoCard({ orderButton: false }), listing), "unknown");
  // Seller prose and page chrome cannot decide availability.
  assert.equal(
    classifyHifidoInventoryPage(
      hifidoCard({ orderButton: false, comment: "前のオーナー様の売約済み品です 完売" }),
      listing,
    ),
    "unknown",
  );
  // Contradictory evidence stays unknown.
  assert.equal(
    classifyHifidoInventoryPage(hifidoCard({ price: "売価:1円売約済み" }), listing),
    "unknown",
  );
});

test("Hifido detail evidence must belong to the listing being rechecked", () => {
  const other = hifidoCard({ id: "26-11111-22222-00", orderButton: false, price: "売約済み" });
  assert.equal(classifyHifidoInventoryPage(other, { sourceUrl: HIFIDO_URL }), "unknown");
  assert.equal(classifyHifidoInventoryPage("<html><body>404</body></html>"), "unknown");
  const two = hifidoCard() + hifidoCard();
  assert.equal(classifyHifidoInventoryPage(two, { sourceUrl: HIFIDO_URL }), "unknown");
});

const FUJIYA_URL = "https://www.fujiya-avic.co.jp/shop/g/g240004022011/";
const FUJIYA_LISTING = { title: "64 Audio ANDROMEDA", model: "ANDROMEDA" };

// Structural selectors observed on the ANDROMEDA seller page, with minimal synthetic content.
function fujiyaPage(lead: string, related = "") {
  return `<html><head><title>x</title></head><body>
    <header><nav>カートに入れる SOLD OUT</nav></header>
    <main><h1>ANDROMEDA</h1>${lead}<h2>関連商品</h2>${related}</main>
    <footer>在庫あり</footer></body></html>`;
}

test("Fujiya recheck accepts only exact goods URLs", () => {
  assert.equal(isFujiyaAvicDetailUrl(FUJIYA_URL), true);
  for (const value of [
    "https://www.fujiya-avic.co.jp/shop/g/g240004022011",
    "https://www.fujiya-avic.co.jp/shop/g/g240004022011/?x=1",
    "https://www.fujiya-avic.co.jp/shop/c/c/",
    "http://www.fujiya-avic.co.jp/shop/g/g240004022011/",
  ])
    assert.equal(isFujiyaAvicDetailUrl(value), false, value);
});

test("Fujiya availability is read from the listing's own product lead only", () => {
  assert.equal(
    classifyFujiyaAvicInventoryPage(fujiyaPage("<p>在庫がありません</p>"), FUJIYA_LISTING),
    "sold_out",
  );
  assert.equal(
    classifyFujiyaAvicInventoryPage(
      fujiyaPage('<input type="submit" class="block-add-cart--btn" value="カートに入れる">'),
      FUJIYA_LISTING,
    ),
    "in_stock",
  );
  // A related product's label, navigation and footer never decide this listing.
  assert.equal(
    classifyFujiyaAvicInventoryPage(
      fujiyaPage("<p>商品説明</p>", "<p>SOLD OUT</p>"),
      FUJIYA_LISTING,
    ),
    "unknown",
  );
  // A page whose heading is another product proves nothing; without identity nothing is decided.
  assert.equal(
    classifyFujiyaAvicInventoryPage(fujiyaPage("<p>在庫がありません</p>"), {
      title: "Shure SE846",
      model: "SE846",
    }),
    "unknown",
  );
  assert.equal(classifyFujiyaAvicInventoryPage(fujiyaPage("<p>在庫がありません</p>")), "unknown");
  // A bot challenge carries no product lead.
  assert.equal(
    classifyFujiyaAvicInventoryPage(
      "<!DOCTYPE html><html><head><title></title><script>window.gokuProps={}</script></head><body></body></html>",
      FUJIYA_LISTING,
    ),
    "unknown",
  );
});
