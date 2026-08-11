import test from 'node:test';
import assert from 'node:assert/strict';
import { hifidoAdapter, parseHifidoListing } from '../src/crawler/shops/hifido.js';

test('Hifido parser keeps factual listing fields only', () => {
  const html = `
    <div class="item">
      <a href="/26-50234-14194-00.html?A=1&G=3&LNG=J">MINIMA AMATOR 2</a>
      <span>注文</span>
      <p>メーカー:SONUS FABER ソナスファベール</p>
      <p>定価:680,000円</p>
      <p>売価(ペア):498,000円(税込)</p>
      <p>スピーカー（海外製品）</p>
      <p>この説明文はDBへ保存しない。</p>
      <img src="/example.jpg" alt="商品画像">
    </div>`;

  const [product] = parseHifidoListing(html);
  assert.equal(product.sourceId, '26-50234-14194-00');
  assert.equal(product.manufacturer, 'SONUS FABER');
  assert.equal(product.model, 'MINIMA AMATOR 2');
  assert.equal(product.priceYen, 498000);
  assert.equal(product.category, 'スピーカー');
  assert.equal(product.stockStatus, 'in_stock');
  assert.equal(product.sourceUrl, 'https://www.hifido.co.jp/26-50234-14194-00.html?A=1&G=3&LNG=J');
  assert.deepEqual(Object.keys(product).sort(), ['category','conditionText','manufacturer','model','priceYen','sourceId','sourceUrl','stockStatus','title'].sort());
});

test('Hifido crawl interval has independent pages', () => {
  const pages = [...hifidoAdapter.pageUrls(3)];
  assert.match(pages[0], /O=0/);
  assert.match(pages[1], /O=50/);
  assert.match(pages[2], /O=100/);
});


test('Hifido sold listings are not treated as available', () => {
  const html = `
    <div class="item">
      <a href="/26-50000-10000-00.html">A-75</a>
      <span>売約済</span>
      <p>メーカー:Accuphase アキュフェーズ</p>
      <p>売価:1,200,000円(税込) 売約済み</p>
      <p>パワーアンプ（トランジスター）</p>
    </div>`;
  const [product] = parseHifidoListing(html);
  assert.equal(product.stockStatus, 'sold_out');
});
