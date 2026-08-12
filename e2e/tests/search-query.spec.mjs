import { expect, test } from '@playwright/test';

test('multi-word search is sent to the product API unchanged and renders its result', async ({ page }) => {
  await page.route('**/api/meta', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'healthy',
      shops: [],
      manufacturers: ['TAD'],
      categories: ['DAC'],
      categoryFacets: []
    })
  }));

  await page.route('**/api/products?**', async route => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') || '';
    const items = q === 'TAD 1000'
      ? [{
          id: 1000,
          shop_key: 'shop-a',
          manufacturer: 'TAD',
          manufacturer_id: 'tad',
          raw_manufacturer: 'Technical Audio Devices',
          model: 'D1000MK2',
          title: 'TAD D1000MK2',
          category: 'DAC',
          raw_category: 'D/Aコンバーター',
          primary_category_id: 'dac',
          category_ids: ['dac'],
          condition_text: '中古',
          price_yen: 500000,
          previous_price_yen: null,
          stock_status: 'in_stock',
          source_url: 'https://example.com/tad-d1000mk2',
          first_seen_at: '2026-08-12T00:00:00.000Z',
          last_seen_at: '2026-08-12T00:00:00.000Z',
          last_changed_at: '2026-08-12T00:00:00.000Z',
          last_activity_at: '2026-08-12T00:00:00.000Z',
          search_aliases: 'DAC D/A Converter'
        }]
      : [];
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items, hasMore: false, nextCursor: null, totalCount: items.length, totalPages: items.length ? 1 : 0 })
    });
  });

  await page.goto('/');
  const searchRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/products' && url.searchParams.get('q') === 'TAD 1000';
  });
  await page.locator('#q').fill('TAD 1000');
  await searchRequest;

  await expect(page.getByRole('link', { name: 'D1000MK2' })).toBeVisible();
});
