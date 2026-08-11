import test from 'node:test';
import assert from 'node:assert/strict';
import { fujiyaAvicAdapter, parseFujiyaResultCount } from '../src/crawler/shops/fujiya-avic.js';

test('Fujiya initial crawl covers every current used-audio root', () => {
  const pages = [...fujiyaAvicAdapter.pageUrls(50)];
  assert.equal(pages.length, 5);
  assert.ok(pages.some(page => page.url.includes('/rA-EAPU/')));
  assert.ok(pages.some(page => page.url.includes('/rA-HPAU/')));
  assert.ok(pages.some(page => page.url.includes('/rA-HDPU/')));
  assert.ok(pages.some(page => page.url.includes('/rA-HMLU/')));
  assert.ok(pages.some(page => page.url.includes('/rA-DTMU/')));
});

test('Fujiya pagination is derived from the live result count', () => {
  assert.equal(parseFujiyaResultCount('<div>検索結果735件</div>'), 735);
  assert.equal(parseFujiyaResultCount('<div>該当件数391件</div>'), 391);

  const [earphoneRoot] = [...fujiyaAvicAdapter.pageUrls(50)];
  const discovered = fujiyaAvicAdapter.discoverPageUrls('<div>検索結果735件</div>', earphoneRoot);
  assert.equal(discovered.length, 14);
  assert.match(discovered.at(-1).url, /rA-EAPU_p15\/\?ps=50$/);
});

test('Fujiya refuses to claim complete coverage when count cannot be discovered', () => {
  const [root] = [...fujiyaAvicAdapter.pageUrls(50)];
  assert.equal(fujiyaAvicAdapter.discoverPageUrls('<html>layout changed</html>', root), null);
});

test('Fujiya live-card shape parses price, rank, stock and bilingual maker correctly', () => {
  const page = { url: 'https://www.fujiya-avic.co.jp/shop/r/rA-HMLU/?ps=50', category: 'アンプ・スピーカー・プレーヤー' };
  const html = `
    <div class="product">
      <img alt="在庫あり">
      <div>中古：AB</div>
      <a href="/shop/g/g240001214761/">Bowers & Wilkins バウワースアンドウィルキンス FS-700S3/B</a>
      <span>￥57,900(税込)</span>
    </div>`;
  const [item] = fujiyaAvicAdapter.parse(html, page);
  assert.equal(item.manufacturer, 'Bowers & Wilkins');
  assert.equal(item.model, 'FS-700S3/B');
  assert.equal(item.priceYen, 57900);
  assert.equal(item.conditionText, '中古：AB');
  assert.equal(item.stockStatus, 'in_stock');
  assert.equal(item.sourceUrl, 'https://www.fujiya-avic.co.jp/shop/g/g240001214761/');
});

test('Fujiya DJ/DTM listings keep the source category', () => {
  const page = { url: 'https://www.fujiya-avic.co.jp/shop/r/rA-DTMU/?ps=50', category: 'DJ機器・DTM' };
  const html = `
    <div class="product">
      <img alt="在庫あり">
      <div>中古：AB+</div>
      <a href="/shop/g/g240001299999/">Pioneer DJ パイオニアディージェー DDJ-FLX4</a>
      <span>￥39,800(税込)</span>
    </div>`;
  const [item] = fujiyaAvicAdapter.parse(html, page);
  assert.equal(item.category, 'DJ機器・DTM');
  assert.equal(item.priceYen, 39800);
  assert.equal(item.stockStatus, 'in_stock');
});
