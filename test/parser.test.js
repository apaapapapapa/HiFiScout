import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProductPage } from '../src/crawler/parser.js';

test('parses JSON-LD without copying description or image', () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"LUXMAN - D-10X《JP-u》","url":"/shopdetail/USED-1","image":"/copyrighted.jpg","description":"do not store","offers":{"price":"780000","availability":"https://schema.org/InStock"}}</script>`;
  const [item] = parseProductPage(html, { shopKey: 'ippinkan', baseUrl: 'https://ippinkan.jp', productUrlPattern: /shopdetail/ });
  assert.equal(item.manufacturer, 'LUXMAN');
  assert.equal(item.priceYen, 780000);
  assert.equal(item.stockStatus, 'in_stock');
  assert.equal('image' in item, false);
  assert.equal('description' in item, false);
});
