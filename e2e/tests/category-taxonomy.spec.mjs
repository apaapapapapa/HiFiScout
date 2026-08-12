import { expect, test } from '@playwright/test';

const categoryFacets = [
  { id: 'amplifier', name: 'アンプ', parentId: null, order: 1, classifiable: false, filterable: true, group: null, activeProductCount: 3 },
  { id: 'integrated_amp', name: '　プリメインアンプ', parentId: 'amplifier', order: 1, classifiable: true, filterable: true, group: null, activeProductCount: 1 },
  { id: 'pre_amp', name: '　プリアンプ', parentId: 'amplifier', order: 2, classifiable: true, filterable: true, group: null, activeProductCount: 1 },
  { id: 'power_amp', name: '　パワーアンプ', parentId: 'amplifier', order: 3, classifiable: true, filterable: true, group: null, activeProductCount: 1 },
  { id: 'headphone_amp', name: '　ヘッドホンアンプ', parentId: 'amplifier', order: 4, classifiable: true, filterable: true, group: null, activeProductCount: 0 },
  { id: 'digital', name: 'デジタル', parentId: null, order: 2, classifiable: false, filterable: true, group: null, activeProductCount: 2 },
  { id: 'dac', name: '　DAC', parentId: 'digital', order: 1, classifiable: true, filterable: true, group: null, activeProductCount: 1 },
  { id: 'network_player', name: '　ネットワークプレーヤー', parentId: 'digital', order: 2, classifiable: true, filterable: true, group: null, activeProductCount: 1 },
  { id: 'analog', name: 'アナログ', parentId: null, order: 3, classifiable: false, filterable: true, group: null, activeProductCount: 0 },
  { id: 'speaker', name: 'スピーカー', parentId: null, order: 4, classifiable: false, filterable: true, group: null, activeProductCount: 1 },
  { id: 'speaker_bookshelf', name: '　ブックシェルフ', parentId: 'speaker', order: 1, classifiable: true, filterable: true, group: null, activeProductCount: 1 },
  { id: 'headphone_group', name: 'ヘッドホン', parentId: null, order: 5, classifiable: false, filterable: true, group: null, activeProductCount: 0 },
  { id: 'accessories', name: 'アクセサリー', parentId: null, order: 6, classifiable: false, filterable: true, group: null, activeProductCount: 0 },
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

test('live metadata exposes the complete canonical taxonomy including zero-count parents', async ({ request }) => {
  const response = await request.get('/api/meta');
  expect(response.ok()).toBeTruthy();
  const meta = await response.json();
  const facets = meta.categoryFacets || [];

  expect(facets.map(category => category.id)).toEqual([
    'amplifier', 'integrated_amp', 'pre_amp', 'power_amp', 'headphone_amp',
    'digital', 'dac', 'network_player', 'cd_sacd_player', 'dap',
    'analog', 'turntable', 'tonearm', 'cartridge', 'phono_eq',
    'speaker', 'speaker_bookshelf', 'speaker_floorstanding', 'subwoofer', 'speaker_other',
    'headphone_group', 'headphone', 'earphone',
    'accessories', 'cable', 'rack', 'power_accessory', 'vacuum_tube', 'other_accessory',
    'dj_dtm', 'other'
  ]);
  expect(facets.find(category => category.id === 'amplifier')).toMatchObject({
    name: 'アンプ', group: null, classifiable: false, filterable: true
  });
  expect(facets.find(category => category.id === 'speaker')).toMatchObject({
    name: 'スピーカー', group: null, classifiable: false, filterable: true
  });
  expect(facets.find(category => category.id === 'pre_amp')).toMatchObject({ name: '　プリアンプ', parentId: 'amplifier' });
  expect(facets.every(category => Number.isInteger(category.activeProductCount) && category.activeProductCount >= 0)).toBeTruthy();
});

test('category taxonomy keeps separators, canonical order and parent/leaf URL state', async ({ page }) => {
  const requests = await mockCatalog(page);
  await page.goto('/');

  const parentIds = ['amplifier', 'digital', 'analog', 'speaker', 'headphone_group', 'accessories'];
  await expect.poll(
    () => page.locator('#category option[data-category-separator="true"]').count(),
    { message: 'category group separators should be rendered after metadata loads' }
  ).toBe(parentIds.length);

  const options = await page.locator('#category option').evaluateAll(nodes => nodes.map(node => ({
    value: node.value,
    text: node.textContent,
    separator: node.dataset.categorySeparator === 'true',
    disabled: node.disabled
  })));
  const selectable = options.filter(option => !option.separator);
  expect(selectable.slice(0, 7).map(({ value, text }) => ({ value, text }))).toEqual([
    { value: '', text: 'すべて' },
    { value: 'amplifier', text: 'アンプ' },
    { value: 'integrated_amp', text: '　プリメインアンプ' },
    { value: 'pre_amp', text: '　プリアンプ' },
    { value: 'power_amp', text: '　パワーアンプ' },
    { value: 'headphone_amp', text: '　ヘッドホンアンプ' },
    { value: 'digital', text: 'デジタル' }
  ]);
  expect(selectable.slice(-2).map(({ value, text }) => ({ value, text }))).toEqual([
    { value: 'dj_dtm', text: 'DJ機器・DTM' },
    { value: 'other', text: 'その他' }
  ]);

  for (const id of parentIds) {
    const parentIndex = options.findIndex(option => option.value === id && !option.separator);
    expect(parentIndex).toBeGreaterThan(0);
    expect(options[parentIndex - 1]).toMatchObject({
      text: '────────────',
      separator: true,
      disabled: true
    });
  }

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
