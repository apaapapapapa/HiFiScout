# Adding a shop

A shop is a plugin, not a change to the crawler. Discovery, transport, normalization, identity, persistence, search projection, evidence, and data quality are platform behavior; a shop contributes definition metadata, listing entry points, a parser, availability mapping, optional declared capabilities, fixtures, and tests. Adding one must not require editing `run.ts`, `dispatch.ts`, a repository, or a type union in `src/crawler/types.ts`.

Use the scaffold generator so every collector starts from the same contract.

```bash
npm run create-shop -- \
  --key example-audio \
  --name "Example Audio" \
  --base-url https://example.com \
  --transport direct \
  --interval 60
```

Supported transports are `direct`, `relay`, and `browser`. The base URL must be an `https` origin: it is the robots.txt origin and the guard every crawl target is checked against. The generator creates:

- `src/crawler/shops/<key>.ts` — an adapter typed `satisfies ShopAdapter`
- `test/<key>.test.ts`
- `test/fixtures/<key>/list.html`
- a plugin registration in `src/crawler/shops/index.ts`

Nothing else needs editing to register the shop: `npm run typecheck`, `npm run format:check`, and `npm test` all pass on a freshly generated scaffold.

The generated parser intentionally returns no products, and the registration carries `defaultEnabled: false` so it cannot crawl just by being merged. Remove that line once a real parser and a representative fixture are in place.

## Configuration

Shop settings are derived from the definition, never declared separately. The key's SCREAMING_SNAKE_CASE form is the shop's environment prefix, and the platform reads these names:

| Variable | Meaning | Default |
| --- | --- | --- |
| `<PREFIX>_ENABLED` | kill switch | `defaultEnabled`, else on |
| `<PREFIX>_INTERVAL_MINUTES` | crawl interval | `defaultIntervalMinutes` |
| `<PREFIX>_REQUEST_DELAY_MS` | per-request pacing | `defaultRequestDelayMs`, else the global delay |
| `<PREFIX>_MAX_PAGES` | page ceiling | `defaultMaxPages`, else the global ceiling |
| `<PREFIX>_INVENTORY_RECHECK_*` | recheck policy settings | off unless enabled |

Declare deployed values in `wrangler.jsonc`. A shop whose deployed variables already use another spelling states `envPrefix` on its definition instead of being renamed. Settings the shop reads itself — a discovery entry point, for example — are ordinary `Env` variables and belong in `wrangler.jsonc` alongside the rest.

`defineShopPlugin` validates the definition at module load, so an invalid key, a non-origin or non-https base URL, a non-positive interval, an unsupported transport, or two shops sharing an env prefix or a cron fails in CI rather than during a scheduled crawl. Registered definitions are frozen.

## Product fields

A parser returns seller facts — `ShopParsedProduct` in `src/catalog/types.ts`. Catalog normalization is applied centrally at the shop-plugin boundary before persistence, so a parser never produces persistence rows or cross-shop identity.

```ts
interface ShopParsedProduct {
  sourceId: string;
  sourceUrl: string;
  title: string;
  manufacturer: string;
  rawManufacturer?: string;
  model: string;
  category?: string;
  rawCategory?: string;
  conditionText: string;
  priceYen: number | null;
  stockStatus: "in_stock" | "sold_out" | "unknown";
  sourcePublishedAt?: string | null;
  metadata?: Record<string, unknown>;
}
```

`rawManufacturer` and `rawCategory` should contain the seller's original values whenever the page exposes them. `manufacturer` and `category` may contain the parser's best candidate/hint; the catalog layer converts them to HiFiScout canonical manufacturer/category values.

`stockStatus` is the shop's mapping of its own availability wording onto the canonical vocabulary, and it belongs in the adapter with tests. Never infer `in_stock` from a successful parse: evidence that is contradictory or absent is `unknown`, which stays distinguishable from a confirmed state everywhere downstream.

A normalized persisted product (`NormalizedCatalogProduct`) additionally has `manufacturerId`, `primaryCategoryId`, `categoryIds`, `classificationStatus`, and `searchAliases`.

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

```ts
export const exampleAudioAdapter = {
  key: "example-audio",
  name: "Example Audio",
  baseUrl: BASE_URL,
  categoryMapping: {
    コントロールアンプ: "pre_amp",
    パワーアンプ: "power_amp",
    ネットワークDAC: ["dac", "network_player"],
  },
  categoryPolicy: {
    sellerCategory: {
      default: "authoritative",
      categories: {
        dap: "corroborative",
      },
    },
    parserHint: "corroborative",
    enrichment: {
      maxRequestsPerCrawl: 20,
      cacheHours: 168,
    },
  },
  // ...
} satisfies ShopAdapter;
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

```ts
import { categoryEvidenceFromText } from "../../catalog/category-evidence.js";

export const exampleAudioAdapter = {
  // ...
  extractDetailCategoryEvidence(html: string, product: NormalizedCatalogProduct) {
    const productSpecificLabel = extractProductSpecificLabel(html, product);
    return categoryEvidenceFromText(productSpecificLabel, {
      source: "detail_metadata",
      strength: "strong",
      context: "detail",
    });
  },
} satisfies ShopAdapter;
```

The extractor should return evidence, not make the final category decision. Prefer structured/product-specific metadata, breadcrumb labels, or the product's lead description. Do not scan an entire detail page indiscriminately: related-product and cross-sell text can mention different component types and create false evidence.

Detail enrichment is intentionally bounded by `maxRequestsPerCrawl` and only runs for unresolved products. This avoids multiplying seller requests for products already classified from the listing.

## Shop-specific metadata

Shop-specific factual fields belong in `metadata` instead of new `products` columns:

```ts
{
  sourceId: "123",
  rawManufacturer: "Example Audio Co., Ltd.",
  manufacturer: "Example Audio",
  model: "Model 1",
  title: "Example Audio Model 1",
  rawCategory: "Control Amplifier",
  category: "プリアンプ",
  conditionText: "A",
  priceYen: 100_000,
  stockStatus: "in_stock",
  sourceUrl: "https://example.com/used/123",
  metadata: {
    storeName: "Tokyo",
    warranty: "6 months",
    accessories: ["remote", "box"],
  },
}
```

`metadata` must be a JSON object. HiFiScout sorts keys before comparison, stores at most 50 top-level keys, limits key names to 64 characters, and rejects metadata larger than 8 KiB per product. Missing metadata is stored as `{}`. Metadata changes update `last_changed_at`, but unchanged metadata does not create a D1 write on every crawl.

Only factual seller information should be stored. Do not use metadata to copy descriptions, staff comments, images, or other editorial content.

## Before enabling the collector

1. Replace the generated fixture with representative, sanitized listing HTML covering the variants that matter: a normal listing, sold out / negotiating / unknown availability, pagination termination, and a malformed or empty page.
2. Implement `pageUrls()` and `parse()`. Discovery must stay bounded and must not fetch pages itself; pagination beyond fixed entry points is `dynamicPagination` plus `discoverPageUrls()`, which returns `null` when coverage is unknown so nothing is deactivated on a guess.
3. Capture `rawCategory`/`rawManufacturer` when the seller exposes them and define `categoryMapping` for seller-specific category names.
4. Decide whether seller categories are authoritative or only corroborative; configure `categoryPolicy` for broad buckets.
5. Map the seller's availability wording to `stockStatus`, and test that mapping at the shop boundary rather than in generic crawler code.
6. Add `extractDetailCategoryEvidence()` only when listing evidence is insufficient, and keep it product-specific.
7. Add parser/classifier assertions for raw fields, canonical classification, unresolved behavior, and any metadata fields.
8. Run `npm test` and the Wrangler deploy dry-run through CI.
9. Check robots.txt and the site's current terms.
10. Declare the shop's `<PREFIX>_*` values in `wrangler.jsonc`, and for relay collectors ensure `CRAWL_RELAY_URL` and `CRAWL_RELAY_TOKEN` are configured.
11. Remove `defaultEnabled: false` from the registration last, once everything above holds.
