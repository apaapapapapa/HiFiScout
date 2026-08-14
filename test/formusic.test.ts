import test from "node:test";
import assert from "node:assert/strict";
import { forMusicAdapter, parseForMusicListing } from "../src/crawler/shops/formusic.js";

const html = `
<table class="itemlist">
<tr><th colspan="8"><img src="/ct.png" alt="Speaker System" /></th></tr>
<tr id="post-37194" class="post-37194 post hentry category-speaker-system tag-bowerswilkins">
  <td width="60"><a href="https://shop.formusic.jp/speaker-system/37194.html"><img src="/copyrighted.jpg" alt="805D3 グロスブラック"></a></td>
  <td>Bowers&amp;Wilkins<br /></td>
  <td><h2 class="page-title"><a href="https://shop.formusic.jp/speaker-system/37194.html">805D3 グロスブラック</a></h2></td>
  <td><span class="post-meta-teika">定価</span><br><span class="post-meta-baika">売価</span></td>
  <td><span class="post-meta-teika">1,012,000 円</span><br><span class="post-meta-baika">660,000 円</span></td>
  <td><span class="post-meta-teido">美品：A</span></td>
  <td><a href="https://shop.formusic.jp/speaker-system/37194.html"><img alt="VIEW"></a></td>
  <td><img alt="中古"><br><img alt="新入荷"></td>
</tr>
<tr id="post-37001" class="post-37001 post hentry category-speaker-system tag-piega">
  <td><a href="/speaker-system/37001.html"><img src="/display.jpg" alt="Premium 701 gen2"></a></td>
  <td>PIEGA<br />ピエガ</td>
  <td><h2 class="page-title"><a href="/speaker-system/37001.html">Premium 701 gen2</a></h2></td>
  <td>定価<br>売価</td>
  <td><span class="post-meta-teika">1,375,000 円</span><br><span class="post-meta-baika">1,034,000 円</span></td>
  <td><span class="post-meta-teido">美品：A</span></td>
  <td><img alt="VIEW"></td>
  <td><img alt="展示現品"><br><img alt="商談中"></td>
</tr>
<tr id="post-36000" class="post-36000 post hentry category-accessories tag-cad">
  <td><a href="/accessories/36000.html"><img src="/new.jpg" alt="NEW ITEM"></a></td>
  <td>CAD</td>
  <td><h2 class="page-title"><a href="/accessories/36000.html">NEW ITEM</a></h2></td>
  <td>定価<br>売価</td>
  <td><span class="post-meta-teika">66,000 円</span><br><span class="post-meta-baika">46,200 円</span></td>
  <td><span class="post-meta-teido">極上：S</span></td>
  <td><img alt="VIEW"></td>
  <td><img alt="新品"></td>
</tr>
<tr id="post-35000" class="post-35000 post hentry category-control-amplifiers tag-luxman">
  <td><a href="/control-amplifiers/35000.html"><img src="/sold.jpg" alt="C-10X"></a></td>
  <td>LUXMAN<br />ラックスマン</td>
  <td><h2 class="page-title"><a href="/control-amplifiers/35000.html">C-10X</a></h2></td>
  <td>定価<br>売価</td>
  <td><span class="post-meta-teika">1,650,000 円</span><br><span class="post-meta-baika">SOLD OUT 円</span></td>
  <td><span class="post-meta-teido">美品：A</span></td>
  <td><img alt="VIEW"></td>
  <td><img alt="売約済"></td>
</tr>
<tr id="post-34000" class="post-34000 post hentry category-music-book tag-label">
  <td><a href="/music-book/34000.html"><img src="/record.jpg" alt="LP"></a></td>
  <td>LABEL</td>
  <td><h2 class="page-title"><a href="/music-book/34000.html">LP</a></h2></td>
  <td>定価<br>売価</td>
  <td><span class="post-meta-teika">5,000 円</span><br><span class="post-meta-baika">3,000 円</span></td>
  <td><span class="post-meta-teido">美品：A</span></td>
  <td><img alt="VIEW"></td>
  <td><img alt="中古"></td>
</tr>
</table>`;

test("FOR MUSIC parser keeps used/display listings and factual fields only", () => {
  const items = parseForMusicListing(html);
  assert.equal(items.length, 3);

  const used = items.find((item) => item.sourceId === "37194");
  assert.ok(used);
  assert.equal(used.manufacturer, "Bowers&Wilkins");
  assert.equal(used.model, "805D3 グロスブラック");
  assert.equal(used.category, "スピーカー");
  assert.equal(used.priceYen, 660000);
  assert.equal(used.stockStatus, "in_stock");
  assert.match(used.conditionText, /美品：A/);
  assert.match(used.conditionText, /中古/);
  assert.equal("image" in used, false);
  assert.equal("description" in used, false);

  const display = items.find((item) => item.sourceId === "37001");
  assert.ok(display);
  assert.equal(display.priceYen, 1034000);
  assert.equal(display.stockStatus, "unknown");
  assert.match(display.conditionText, /展示現品/);
  assert.match(display.conditionText, /商談中/);

  const sold = items.find((item) => item.sourceId === "35000");
  assert.ok(sold);
  assert.equal(sold.manufacturer, "LUXMAN");
  assert.equal(sold.category, "プリアンプ");
  assert.equal(sold.priceYen, null);
  assert.equal(sold.stockStatus, "sold_out");
});

test("FOR MUSIC adapter uses one complete storefront snapshot", () => {
  assert.deepEqual([...forMusicAdapter.pageUrls()], ["https://shop.formusic.jp/"]);
  assert.equal(forMusicAdapter.dynamicPagination, true);
  assert.deepEqual(forMusicAdapter.discoverPageUrls(), []);
});
