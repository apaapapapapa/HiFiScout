import { expect, test } from '@playwright/test';

const categoryFacets = [
  { id: 'amplifier', name: 'アンプ（すべて）', parentId: null, order: 1, classifiable: false, filterable: true, group: 'アンプ', activeProductCount: 3 },
  { id: 'integrated_amp', name: 'プリメインアンプ', parentId: 'amplifier', order: 1, classifiable: true, filterable: true, group: 'アンプ', activeProductCount: 1 },
  { id: 'pre_amp', name: 'プリアンプ', parentId: 'amplifier', order: 2, classifiable: true, filterable: true, group: 'アンプ', activeProductCount: 1 },
  { id: 'power_amp', name: 'パワーアンプ', parentId: 'amplifier', order: 3, classifiable: true, filterable: true, group: 'アンプ', activeProductCount: 1 },
  { id: 'headphone_amp', name: 'ヘッドホンアンプ', parentId: 'amplifier', order: 4, classifiable: true, filterable: true, group: 'アンプ', activeProductCount: 0 },
  { id: 'digital', name: 'デジタル（すべて）', parentId: null, order: 2, classifiable: false, filterable: true, group: 'デジタル', activeProductCount: 2 },
  { id: 'dac', name: 'DAC', parentId: 'digital', order: 1, classifiable: true, filterable: true, group: 'デジタル', activeProductCount: 1 },
  { id: 'network_player', name: 'ネットワークプレーヤー', parentId: 'digital', order: 2, classifiable: true, filterable: true, group: 'デジタル', activeProductCount: 1 },
  { id: 'analog', name: 'アナログ（すべて）', parentId: null, order: 3, classifiable: false, filterable: true, group: 'アナログ', activeProductCount: 0 },
  { id: 'speaker', name: 'スピーカー（すべて）', parentId: null, order: 4, classifiable: false, filterable: true, group: 'スピーカー', activeProductCount: 1 },
  { id: 'speaker_bookshelf', name: 'ブックシェルフ', parentId: 'speaker', order: 1, classifiable: true, filterable: true, group: 'スピーカー', activeProductCount: 1 },
  { id: 'headphone_group', name: 'ヘッドホン（すべて）', parentId: null, order: 5, classifiable: false, filterable: true, group: 'ヘッドホン', activeProductCount: 0 },
  { id: 'accessories', name: 'アクセサリー（すべて）', parentId: null, order: 6, classifiable: false, filterable: true, group: 'アクセサリー', activeProductCount: 0 },
  { id: 'dj_dtm', name: 'DJ機器・DTM', parentId: null, order: 7, classifiable: true, filterable: true, group: null, activeProductCount: 0 },
  { id: 'other', name: 'その他', parentId: null, order: 8, classifiable: true, filterable: true, group: null, activeProductCount: 0 }
];

async function mockCatalog(page) {
  await page.route('**/api/meta', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ status: 'healthy', shops: [], manufacturers: [], categories: [], categoryFacets })
  }));
  const requests = [];
  await page.route('**/api/products?**', route => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [], hasMore: false, nextCursor: null }) });
  });
  return requests;
}

test('category taxonomy keeps canonical order and parent/leaf URL state', async ({ page }) => {
  const requests = await mockCatalog(page);
  await page.goto('/');

  const groups = await page.locator('#category optgroup').evaluateAll(nodes => nodes.map(node => node.label));
  expect(groups).toEqual(['アンプ', 'デジタル', 'アナログ', 'スピーカー', 'ヘッドホン', 'アクセサリー']);
  await expect(page.locator('#category option').first()).toHaveText('すべて');
  await expect(page.locator('#category optgroup[label="アンプ"] option').first()).toHaveText(/アンプ（すべて）/);
  await expect(page.locator('#category optgroup[label="アンプ"] option').nth(2)).toHaveText(/プリアンプ/);

  await page.locator('#category').selectOption('amplifier');
  await expect(page).toHaveURL(/category=amplifier/);
  expect(requests.at(-1).searchParams.get('category')).toBe('amplifier');

  await page.locator('#category').selectOption('pre_amp');
  await expect(page).toHaveURL(/category=pre_amp/);
  expect(requests.at(-1).searchParams.get('category')).toBe('pre_amp');

  await page.goto('/?category=speaker_bookshelf');
  await expect(page.locator('#category')).toHaveValue('speaker_bookshelf');
  expect(requests.at(-1).searchParams.get('category')).toBe('speaker_bookshelf');
});
