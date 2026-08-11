# Adding a shop

Use the scaffold generator so every collector starts with the same plugin contract, fixture layout, and environment-variable naming.

```bash
npm run create-shop -- \
  --key example-audio \
  --name "Example Audio" \
  --base-url https://example.com \
  --transport direct \
  --interval 60
```

Supported transports are `direct`, `relay`, and `browser`. The generator creates:

- `src/crawler/shops/<key>.js`
- `test/<key>.test.js`
- `test/fixtures/<key>/list.html`
- a plugin registration in `src/crawler/shops/index.js`

The generated parser intentionally returns no products. Replace it with a parser backed by the sanitized fixture before enabling the shop.

## Product fields

Fields used for cross-shop search, filtering, sorting, stock handling, and price history stay in the normalized product model:

```js
{
  sourceId,
  manufacturer,
  model,
  title,
  category,
  conditionText,
  priceYen,
  stockStatus,
  sourceUrl
}
```

Shop-specific factual fields belong in `metadata` instead of new `products` columns:

```js
{
  sourceId: '123',
  manufacturer: 'Example',
  model: 'Model 1',
  title: 'Example Model 1',
  category: 'アンプ',
  conditionText: 'A',
  priceYen: 100000,
  stockStatus: 'in_stock',
  sourceUrl: 'https://example.com/used/123',
  metadata: {
    storeName: 'Tokyo',
    warranty: '6 months',
    accessories: ['remote', 'box']
  }
}
```

`metadata` must be a JSON object. HiFiScout sorts keys before comparison, stores at most 50 top-level keys, limits key names to 64 characters, and rejects metadata larger than 8 KiB per product. Missing metadata is stored as `{}`. Metadata changes update `last_changed_at`, but unchanged metadata does not create a D1 write on every crawl.

Only factual seller information should be stored. Do not use metadata to copy descriptions, staff comments, images, or other editorial content.

## Before enabling the collector

1. Replace the generated fixture with representative, sanitized listing HTML.
2. Implement `pageUrls()` and `parse()`.
3. Add parser assertions for expected normalized fields and any metadata fields.
4. Run `npm test` and the Wrangler deploy dry-run through CI.
5. Check robots.txt and the site's current terms.
6. Configure the generated `<SHOP>_ENABLED`, `<SHOP>_INTERVAL_MINUTES`, and `<SHOP>_REQUEST_DELAY_MS` variables.
7. For relay collectors, ensure `CRAWL_RELAY_URL` and `CRAWL_RELAY_TOKEN` are configured.
