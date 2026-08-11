import { expect, test } from '@playwright/test';

function isProductsRequest(response) {
  const url = new URL(response.url());
  return url.pathname === '/api/products' && response.request().method() === 'GET';
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
  await expect(page.locator('#count')).toHaveText(/^\d+\+?$/);
});

test('changing a shop filter sends the selected shop to the API and refreshes the UI', async ({ page }) => {
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
  const payload = await filteredResponse.json();
  expect(Array.isArray(payload.items)).toBeTruthy();
  await expect(page.locator('#shop')).toHaveValue(firstShop.value);
  await expect(page.locator('#count')).toHaveText(/^\d+\+?$/);
  await expect(page.locator('#products')).not.toContainText('商品の取得に失敗しました。');
});
