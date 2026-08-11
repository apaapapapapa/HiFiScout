import test from 'node:test';
import assert from 'node:assert/strict';
import { audioUnionAdapter } from '../src/crawler/shops/audiounion.js';

test('Audio Union uses only the allowed new-arrival used feed', () => {
  const urls = [...audioUnionAdapter.pageUrls(40, {})];
  assert.deepEqual(urls, ['https://www.audiounion.jp/st/new_arrival_used.html']);
});

test('Audio Union parses used detail id and yen HTML entity', () => {
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
  assert.equal(item.sourceUrl, 'https://www.audiounion.jp/ct/detail/used/226086/');
});
