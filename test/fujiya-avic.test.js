import test from 'node:test';
import assert from 'node:assert/strict';
import { fujiyaAvicAdapter, parseFujiyaResultCount } from '../src/crawler/shops/fujiya-avic.js';
import { coverageDecision } from '../src/crawler/strategies.js';

test('Fujiya initial crawl starts from the explicitly newest-sorted used arrivals feed with 50 items per page', () => {
  const pages = [...fujiyaAvicAdapter.pageUrls(50)];
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url, 'https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd/?ps=50');
});

test('Fujiya new-arrivals feed is treated as partial coverage', () => {
  assert.equal(fujiyaAvicAdapter.partialCoverage, true);

  const decision = coverageDecision(fujiyaAvicAdapter, {
    reachedEnd: false,
    coverageIncomplete: false,
    queueEmpty: true
  });

  assert.equal(decision.deactivateMissing, false);
  assert.equal(decision.guardItemCount, false);
});

test('Fujiya pagination is derived from the live result count', () => {
  assert.equal(parseFujiyaResultCount('<div>検索結果735件</div>'), 735);
  assert.equal(parseFujiyaResultCount('<div>該当件数391件</div>'), 391);

  const [root] = [...fujiyaAvicAdapter.pageUrls(50)];
  const discovered = fujiyaAvicAdapter.discoverPageUrls('<div>検索結果735件</div>', root);
  assert.equal(discovered.length, 14);
  assert.equal(discovered[0].url, 'https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd_p2/?ps=50');
  assert.match(discovered.at(-1).url, /ea-usednw_ssd_p15\/\?ps=50$/);
});

test('Fujiya refuses to claim complete coverage when count cannot be discovered', () => {
  const [root] = [...fujiyaAvicAdapter.pageUrls(50)];
  assert.equal(fujiyaAvicAdapter.discoverPageUrls('<html>layout changed</html>', root), null);
});

test('Fujiya live-card shape parses price, rank, stock and bilingual maker correctly', () => {
  const page = { url: 'https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd/?ps=50' };
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

test('Fujiya price is taken from the current card, not the previous card', () => {
  const page = { url: 'https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd/?ps=50' };
  const html = `
    <div class="product">
      <img alt="在庫あり">
      <div>中古：AB+</div>
      <a href="/shop/g/g240001300001/">SilentPower サイレントパワー OMNI USB [SLP-OMNI-USB]</a>
      <span>￥119,300(税込)</span>
    </div>
    <div class="product">
      <img alt="在庫あり">
      <div>中古：AB+</div>
      <a href="/shop/g/g240001300002/">SilentPower サイレントパワー OMNI USB [SLP-OMNI-USB]</a>
      <span>￥119,800(税込)</span>
    </div>`;
  const items = fujiyaAvicAdapter.parse(html, page);
  assert.equal(items.length, 2);
  assert.equal(items[0].priceYen, 119300);
  assert.equal(items[1].priceYen, 119800);
});

test('Fujiya DJ/DTM listings remain classifiable from the new arrivals feed', () => {
  const page = { url: 'https://www.fujiya-avic.co.jp/shop/e/ea-usednw_ssd/?ps=50' };
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
