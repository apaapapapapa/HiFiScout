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

- `src/crawler/shops/<key>.ts`
- `test/<key>.test.ts`
- `test/fixtures/<key>/list.html`
- a plugin registration in `src/crawler/shops/index.ts`

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

During collection a product also carries `classificationState`, `candidateCategoryIds`, and category evidence for diagnostics/enrichment. `classification_status` remains the stable persisted `classified` / `unclassified` value; richer state such as `ambiguous` is retained in `metadata.categoryClassification`.

`primaryCategoryId` is the product's main category. `categoryIds` contains only confirmed categories and may contain more than one category for products that genuinely span categories. Candidate categories for an unresolved product must never be written to `product_categories`, so uncertain evidence cannot leak into category filters.

HiFiScout does not use capability/feature classification here; feature-level filtering can be introduced independently later if needed.

## Category evidence and shop policy

Category classification is deterministic and evidence-based. Do not add shop/model-specific `if` statements to the shared taxonomy and do not assign arbitrary numerical confidence scores.

Evidence has three strengths:

- `authoritative`: enough to classify by itself and takes precedence over lower tiers.
- `strong`: explicit product-type evidence such as `SACD player`, `headphone amplifier`, or a product-specific detail label.
- `supporting`: a useful hint that cannot classify a product by itself.

Seller categories can be configured as:

- `authoritative`: the seller category alone may determine the canonical category.
- `corroborative`: keep it only as supporting evidence; another strong/authoritative signal is required.
- `ignore`: do not use it for canonical classification.

Example for a shop whose DAP merchandising bucket also contains heterogeneous products:

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
  categoryPolicy: {
    sellerCategory: {
      default: 'authoritative',
      categories: {
        dap: 'corroborative'
      }
    },
    parserHint: 'corroborative',
    enrichment: {
      maxRequestsPerCrawl: 20,
      cacheHours: 168
    }
  },
  // ...
};
```

Exact `categoryMapping` values are normally authoritative. Broad free-text seller labels that only match shared inference rules are automatically treated as corroborative, even when the shop default is authoritative. This prevents a label such as `アンプ・スピーカー・プレーヤー` from silently becoming a confirmed category.

Classification behavior is:

1. Collect exact seller-category evidence, explicit title evidence, and parser hints.
2. Resolve authoritative evidence first, then strong evidence.
3. Compatible evidence may confirm multiple real categories (for example `dac` + `network_player`).
4. Conflicting evidence becomes `ambiguous`; insufficient evidence becomes `unclassified`.
5. `ambiguous` / `unclassified` products have `categoryIds = []` and therefore do not appear in a canonical category filter.
6. If the shop supports detail enrichment, only unresolved products are fetched and reclassified with product-specific detail evidence.
7. A successful detail check is cached per seller product identity. Network/robots failures are not cached as classification results and remain retryable.

`other` and `unclassified` are deliberately different concepts. `other` is a confirmed product that does not belong to a more specific canonical taxonomy category. `unclassified` means the available evidence is insufficient; do not use `other` as a fallback for missing information.

## Detail category enrichment

A shop may expose `extractDetailCategoryEvidence(html, product)` when its listing data is too coarse to classify some products.

```js
import { categoryEvidenceFromText } from '../../catalog/category-evidence.js';

export const exampleAudioAdapter = {
  // ...
  extractDetailCategoryEvidence(html, product) {
    const productSpecificLabel = extractProductSpecificLabel(html, product);
    return categoryEvidenceFromText(productSpecificLabel, {
      source: 'detail_metadata',
      strength: 'strong',
      context: 'detail'
    });
  }
};
```

The extractor should return evidence, not make the final category decision. Prefer structured/product-specific metadata, breadcrumb labels, or the product's lead description. Do not scan an entire detail page indiscriminately: related-product and cross-sell text can mention different component types and create false evidence.

Detail enrichment is intentionally bounded by `maxRequestsPerCrawl` and only runs for unresolved products. This avoids multiplying seller requests for products already classified from the listing.

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
4. Decide whether seller categories are authoritative or only corroborative; configure `categoryPolicy` for broad buckets.
5. Add `extractDetailCategoryEvidence()` only when listing evidence is insufficient, and keep it product-specific.
6. Add parser/classifier assertions for raw fields, canonical classification, unresolved behavior, and any metadata fields.
7. Run `npm test` and the Wrangler deploy dry-run through CI.
8. Check robots.txt and the site's current terms.
9. Configure the generated `<SHOP>_ENABLED`, `<SHOP>_INTERVAL_MINUTES`, and `<SHOP>_REQUEST_DELAY_MS` variables.
10. For relay collectors, ensure `CRAWL_RELAY_URL` and `CRAWL_RELAY_TOKEN` are configured.
