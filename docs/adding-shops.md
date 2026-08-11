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

Collectors should return seller facts. Catalog normalization is applied centrally at the shop-plugin boundary before persistence.

```js
{
  sourceId,
  rawManufacturer,
  manufacturer,
  model,
  title,
  rawCategory,
  category,
  conditionText,
  priceYen,
  stockStatus,
  sourceUrl
}
```

`rawManufacturer` and `rawCategory` should contain the seller's original values whenever the page exposes them. `manufacturer` and `category` may contain the parser's best candidate/hint; the catalog layer converts them to HiFiScout canonical manufacturer/category values.

A normalized persisted product additionally has:

```js
{
  manufacturerId,
  primaryCategoryId,
  categoryIds,
  classificationStatus,
  searchAliases
}
```

`primaryCategoryId` is the product's main category. `categoryIds` may contain more than one category for products that legitimately span categories. HiFiScout does not use capability/feature classification here; feature-level filtering can be introduced independently later if needed.

## Shop category mapping

If a shop exposes its own category, define `categoryMapping` on that shop's adapter. Keep the mapping next to the collector rather than adding shop-specific conditions to the shared taxonomy.

```js
export const exampleAudioAdapter = {
  key: 'example-audio',
  name: 'Example Audio',
  baseUrl: 'https://example.com',
  categoryMapping: {
    'コントロールアンプ': 'pre_amp',
    'パワーアンプ': 'power_amp',
    'ネットワークDAC': ['dac', 'network_player']
  },
  // ...
};
```

The first category ID is the primary category. All IDs must exist in `src/catalog/categories.js`.

Category resolution order is:

1. exact shop `categoryMapping`
2. shared category aliases
3. parser category hint
4. title inference
5. `other` with `classificationStatus = 'unclassified'`

Unclassified products are logged as `catalog_unclassified` so a new seller/category can be mapped deliberately instead of silently creating another UI option.

The UI exposes only canonical categories and manufacturers. Free-text search still indexes the canonical values, seller raw category/manufacturer, and category aliases, so seller-specific terminology remains searchable without reintroducing duplicate filter choices.

## Shop-specific metadata

Shop-specific factual fields belong in `metadata` instead of new `products` columns:

```js
{
  sourceId: '123',
  rawManufacturer: 'Example Audio Co., Ltd.',
  manufacturer: 'Example Audio',
  model: 'Model 1',
  title: 'Example Audio Model 1',
  rawCategory: 'Control Amplifier',
  category: 'プリアンプ',
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
3. Capture `rawCategory`/`rawManufacturer` when the seller exposes them and define `categoryMapping` for seller-specific category names.
4. Add parser assertions for expected raw fields, canonical classification, and any metadata fields.
5. Run `npm test` and the Wrangler deploy dry-run through CI.
6. Check robots.txt and the site's current terms.
7. Configure the generated `<SHOP>_ENABLED`, `<SHOP>_INTERVAL_MINUTES`, and `<SHOP>_REQUEST_DELAY_MS` variables.
8. For relay collectors, ensure `CRAWL_RELAY_URL` and `CRAWL_RELAY_TOKEN` are configured.
