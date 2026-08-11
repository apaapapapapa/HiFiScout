import test from 'node:test';
import assert from 'node:assert/strict';
import { audioUnionAdapter } from '../src/crawler/shops/audiounion.js';

test('Audio Union uses only the allowed new-arrival used feed', () => {
  const urls = [...audioUnionAdapter.pageUrls(40, {})];
  assert.deepEqual(urls, ['https://www.audiounion.jp/st/new_arrival_used.html']);
});

test('Audio Union treats a listing with a sales price as in stock', () => {
  const html = `
    <article>
      <div>中古</div>
      <a href="https://www.audiounion.jp/ct/detail/used/226086/">KEF LSX II サウンドウェーブ + P1 DeskPad ブラック</a>
      <div>販売価格: &yen;139,800</div>
    </article>`;
  const [item] = audioUnionAdapter.parse(html, 'https://www.audiounion.jp/st/new_arrival_used.html');
  assert.equal(item.sourceId, '226086');
  assert.equal(item.manufacturer, 'KEF');
  assert.equal(item.priceYen, 139800);
  assert.equal(item.stockStatus, 'in_stock');
  assert.equal(item.sourceUrl, 'https://www.audiounion.jp/ct/detail/used/226086/');
});

test('Audio Union prefers the richer duplicate link and current product price', () => {
  const html = `
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/226086/">KEF</a>
      <a href="https://www.audiounion.jp/ct/detail/used/226086/">KEF LSX II サウンドウェーブ + P1 DeskPad ブラック</a>
      <div>販売価格: &yen;139,800</div>
    </article>
    <article>
      <a href="https://www.audiounion.jp/ct/detail/used/225940/">dCS</a>
      <a href="https://www.audiounion.jp/ct/detail/used/225940/">dCS Bartok DAC+ (with Headphone Amplifier)</a>
      <div>販売価格: &yen;1,798,000</div>
    </article>`;
  const items = audioUnionAdapter.parse(html, 'https://www.audiounion.jp/st/new_arrival_used.html');
  const dcs = items.find(item => item.sourceId === '225940');
  assert.equal(dcs.manufacturer, 'dCS');
  assert.equal(dcs.model, 'Bartok DAC+ (with Headphone Amplifier)');
  assert.equal(dcs.priceYen, 1798000);
  assert.equal(dcs.stockStatus, 'in_stock');
});
