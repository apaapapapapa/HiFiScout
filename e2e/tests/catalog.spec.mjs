import { expect, test } from '@playwright/test';

function isProductsRequest(response) {
  const url = new URL(response.url());
  return url.pathname === '/api/products' && response.request().method() === 'GET';
}

function product(overrides = {}) {
  return {
    id: 1,
    shop_key: 'shop-a',
    manufacturer: 'LUXMAN',
    manufacturer_id: 'luxman',
    raw_manufacturer: 'LUXMAN',
    model: 'D-10X',
    title: 'LUXMAN D-10X',
    category: 'CD/SACDプレーヤー',
    raw_category: 'CD/SACDプレーヤー',
    primary_category_id: 'digital-disc-player',
    category_ids: ['digital-disc-player'],
    condition_text: '中古',
    price_yen: 698000,
    previous_price_yen: 748000,
    stock_status: 'in_stock',
    source_url: 'https://example.com/products/1',
    first_seen_at: '2026-08-11T08:00:00.000Z',
    last_seen_at: '2026-08-11T10:00:00.000Z',
    last_changed_at: '2026-08-11T10:00:00.000Z',
    last_activity_at: '2026-08-11T10:00:00.000Z',
    search_aliases: 'SACD CD player',
    ...overrides
  };
}

test('catalog page boots with live metadata and product API', async ({ page }) => {
  const metaResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/meta' && response.request().method() === 'GET';
  });
  const productsResponsePromise = page.waitForResponse(isProductsRequest);

  await page.goto('/');

  const [metaResponse, productsResponse] = await Promise.all([
    metaResponsePromise,
    productsResponsePromise
  ]);

  expect(metaResponse.ok()).toBeTruthy();
  expect(productsResponse.ok()).toBeTruthy();

  const meta = await metaResponse.json();
  const products = await productsResponse.json();
  expect(Array.isArray(meta.shops)).toBeTruthy();
  expect(meta.shops.length).toBeGreaterThan(0);
  expect(Array.isArray(products.items)).toBeTruthy();

  await expect(page.getByRole('heading', { name: 'HiFiScout' })).toBeVisible();
  await expect(page.locator('#sync-status')).not.toContainText('取得中');
  await expect(page.locator('#count')).toHaveText(/^\d+$/);
  await expect(page.locator('#manufacturer')).toHaveAttribute('type', 'search');
  await expect(page.locator('#manufacturer')).toHaveAttribute('list', 'manufacturer-options');
  await expect(page.locator('#manufacturer-options option').first()).toBeAttached();
  await expect(page.locator('#products')).toHaveClass(/view-list/);
  await expect(page.locator('#pagination').getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#load-more')).toHaveCount(0);

  if (products.items.length) {
    const titleLink = page.locator('.product-title-link').first();
    await expect(titleLink).toBeVisible();
    await expect(titleLink).toHaveAttribute('target', '_blank');
  }
});

test('changing a shop filter refreshes the API and exposes a removable filter chip', async ({ page }) => {
  const initialProductsResponse = page.waitForResponse(isProductsRequest);
  await page.goto('/');
  await initialProductsResponse;

  const firstShop = await page.locator('#shop option').evaluateAll(options => {
    const option = options.find(candidate => candidate.value);
    return option ? { value: option.value, label: option.textContent?.trim() || option.value } : null;
  });
  expect(firstShop).not.toBeNull();

  const filteredResponsePromise = page.waitForResponse(response => {
    if (!isProductsRequest(response)) return false;
    return new URL(response.url()).searchParams.get('shop') === firstShop.value;
  });

  await page.locator('#shop').selectOption(firstShop.value);
  const filteredResponse = await filteredResponsePromise;

  expect(filteredResponse.ok()).toBeTruthy();
  await expect(page.locator('#shop')).toHaveValue(firstShop.value);
  await expect(page.locator('#active-filters')).toContainText(firstShop.label);

  const resetResponsePromise = page.waitForResponse(response => {
    if (!isProductsRequest(response)) return false;
    return !new URL(response.url()).searchParams.has('shop');
  });
  await page.locator('[data-clear-filter="shop"]').click();
  await resetResponsePromise;
  await expect(page.locator('#shop')).toHaveValue('');
  await expect(page.locator('#active-filters')).not.toContainText(firstShop.label);
});

test('mobile uses a bottom-sheet filter panel while keeping search visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const initialProductsResponse = page.waitForResponse(isProductsRequest);
  await page.goto('/');
  await initialProductsResponse;

  await expect(page.locator('#q')).toBeVisible();
  await expect(page.locator('#filter-toggle')).toBeVisible();
  await expect(page.locator('#filter-panel')).not.toHaveClass(/open/);

  await page.locator('#filter-toggle').click();
  await expect(page.locator('#filter-panel')).toHaveClass(/open/);
  await expect(page.locator('#filter-toggle')).toHaveAttribute('aria-expanded', 'true');

  await page.locator('#apply-filters').click();
  await expect(page.locator('#filter-panel')).not.toHaveClass(/open/);
  await expect(page.locator('#filter-toggle')).toHaveAttribute('aria-expanded', 'false');
});

test('favorites are stored as product snapshots and rendered without a favorites API', async ({ page }) => {
  let productRequests = 0;
  const first = product();
  const second = product({
    id: 2,
    manufacturer: 'TAD',
    manufacturer_id: 'tad',
    raw_manufacturer: 'TAD',
    model: 'ME1TX',
    title: 'TAD ME1TX',
    category: 'スピーカー',
    primary_category_id: 'speaker',
    category_ids: ['speaker'],
    price_yen: 980000,
    previous_price_yen: null,
    source_url: 'https://example.com/products/2'
  });

  await page.route('**/api/meta', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        shops: [
          { key: 'shop-a', name: 'Shop A', intervalMinutes: 60, sync: null },
          { key: 'shop-b', name: 'Shop B', intervalMinutes: 60, sync: null }
        ],
        manufacturers: ['LUXMAN', 'TAD'],
        categories: ['CD/SACDプレーヤー', 'スピーカー'],
        categoryFacets: [
          { id: 'digital-disc-player', name: 'CD/SACDプレーヤー', group: 'デジタル' },
          { id: 'speaker', name: 'スピーカー', group: null }
        ]
      })
    });
  });

  await page.route('**/api/products?**', async route => {
    productRequests += 1;
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(cursor
        ? { items: [second], hasMore: false, nextCursor: null }
        : { items: [first], hasMore: true, nextCursor: 'cursor-2' })
    });
  });

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'D-10X' })).toBeVisible();
  await page.locator('[data-fav="1"]').click();

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('hifiscout:favorites') || '[]'));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ id: 1, manufacturer: 'LUXMAN', model: 'D-10X' });

  await page.locator('#pagination').getByRole('button', { name: '2' }).click();
  await expect(page.getByRole('link', { name: 'ME1TX' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'D-10X' })).toHaveCount(0);
  const requestsBeforeFavorites = productRequests;

  await page.locator('#favoritesOnly').check();
  await expect(page.getByRole('link', { name: 'D-10X' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ME1TX' })).toHaveCount(0);
  await expect(page.locator('#pagination')).toBeEmpty();
  expect(productRequests).toBe(requestsBeforeFavorites);
});
