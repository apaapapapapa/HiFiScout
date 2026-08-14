# Adding a shop

A shop is a plugin, not a change to the crawler. Discovery, transport, normalization, identity,
persistence, search projection, evidence, and data quality are platform behavior. A shop contributes
only definition metadata, a discovery policy, seller-fact parsing, availability mapping, optional
capabilities, fixtures, and tests.

Adding a normal shop must not require editing `run.ts`, `dispatch.ts`, a repository, or a shop-name
type union in `src/crawler/types.ts`.

Use the scaffold generator:

```bash
npm run create-shop -- \
  --key example-audio \
  --name "Example Audio" \
  --base-url https://example.com \
  --transport direct \
  --interval 60
```

Supported transports are `direct`, `relay`, and `browser`. The base URL must be an `https` origin.
The generator creates the adapter, fixture, parser test and registry entry. The generated parser is
empty and its registration is `defaultEnabled: false`, so a scaffold cannot go live merely by being
merged.

## Universal adapter contract

Every shop uses the same contract:

```ts
interface ShopAdapter<TPage extends CrawlPage = CrawlPage> {
  key: string;
  name: string;
  baseUrl: string;
  discovery: DiscoveryCapability<TPage>;
  parse(html: string, page?: TPage): SellerProduct[];
  // optional declared capabilities: transport/category/detail diagnostics/recheck/etc.
}
```

The parser does **not** control pagination and discovery does **not** parse products. This separation
is enforced by the type contract and by platform tests.

## Discovery and coverage

Discovery returns typed targets. The target may be a URL string or an object with `url` plus
shop-local context used by that shop's parser.

```ts
interface DiscoveryCapability<TPage extends CrawlPage> {
  coverage: "complete" | "partial" | "unknown";
  continueOnEmpty?: boolean;
  guardItemCount?: boolean;
  extraPageAllowance?: number;
  initialTargets(context: DiscoveryContext): Iterable<TPage>;
  discoverTargets?(html: string, page: TPage): readonly TPage[] | null;
}
```

Use the coverage value deliberately:

- `complete`: the discovered target set is a full snapshot. Only this mode may deactivate missing
  products, and only after bounded discovery finishes without uncertainty.
- `partial`: the shop intentionally exposes a subset such as new arrivals or recent pages. Missing
  products are never deactivated from that crawl.
- `unknown`: the configured target set cannot prove whether it covers all seller inventory. Missing
  products are never deactivated.

The platform owns the safety rules: it bounds target count using `maxPages` plus the explicit extra
allowance, validates every target against the shop's configured HTTPS origin, suppresses duplicate
URLs, and tracks incomplete discovery. A shop must never fetch another listing page from inside
`parse()` or `discoverTargets()`.

`discoverTargets()` returns:

- `[]` when that page conclusively exposes no additional targets;
- additional typed targets when pagination/category expansion is known;
- `null` when the page layout prevents the adapter from knowing whether discovery is complete.

The legacy `pageUrls`, `discoverPageUrls`, `dynamicPagination`, `partialCoverage`,
`continueOnEmpty`, `guardItemCount`, and adapter-level `extraPageAllowance` flags are not part of the
contract.

## Seller-product fields

Every parser returns the strict `SellerProduct` shape. `rawManufacturer`, `rawCategory`, and
`category` are required keys even when the seller provides no value; use `""` rather than omitting
them.

```ts
interface SellerProduct {
  sourceId: string;
  sourceUrl: string;
  title: string;
  rawManufacturer: string;
  manufacturer: string;
  model: string;
  rawCategory: string;
  category: string;
  conditionText: string;
  priceYen: number | null;
  stockStatus: "in_stock" | "sold_out" | "unknown";
  sourcePublishedAt?: string | null;
  metadata?: Record<string, unknown>;
}
```

The registry validates seller products at runtime before central catalog normalization. Persistence
fields such as `shop_key`, `is_active`, or timestamps are rejected at this boundary. Parsers therefore
cannot accidentally become a second persistence model.

`rawManufacturer` and `rawCategory` preserve the seller's wording when available. `manufacturer`
and `category` are parser candidates/hints; the catalog layer owns canonical manufacturer/category
resolution, product identity and persistence.

## Availability

Listing parsers and detail-page inventory rechecks use one canonical vocabulary:

```text
in_stock | sold_out | unknown
```

Use `src/crawler/availability.ts` for shared evidence combination. Confirmed contradictory evidence
maps to `unknown`; parser success alone never means `in_stock`. Shop-specific seller semantics stay at
the adapter boundary. Examples:

- a seller that says `商談中` remains purchasable may map it to `in_stock`;
- a seller that treats `商談中` as uncertain maps it to `unknown`;
- an explicit sold marker maps to `sold_out`;
- conflicting sold and available markers map to `unknown`.

The persisted vocabulary remains the existing D1-compatible tri-state. The generic inventory-recheck
lifecycle interprets a detail-page `unknown` as an ambiguous recheck outcome and retries according to
its policy; it does not invent a fourth persisted status.

## Configuration

Shop settings are derived from the definition. The key's SCREAMING_SNAKE_CASE form becomes the
environment prefix and the platform reads:

| Variable | Meaning | Default |
| --- | --- | --- |
| `<PREFIX>_ENABLED` | kill switch | `defaultEnabled`, else on |
| `<PREFIX>_INTERVAL_MINUTES` | crawl interval | `defaultIntervalMinutes` |
| `<PREFIX>_REQUEST_DELAY_MS` | per-request pacing | `defaultRequestDelayMs`, else global |
| `<PREFIX>_MAX_PAGES` | discovery ceiling | `defaultMaxPages`, else global |
| `<PREFIX>_INVENTORY_RECHECK_*` | recheck settings | off unless capability enabled |

Declare deployed values in `wrangler.jsonc`. A shop whose deployed names use a different spelling may
set `envPrefix` on its definition. Shop-owned discovery inputs such as an entry URL are ordinary env
variables read inside that shop module.

`defineShopPlugin` validates the definition and discovery policy at module load. Invalid keys, non-HTTPS
origins, invalid coverage, negative allowances, unsupported transports, duplicate environment prefixes,
or duplicate crons fail CI rather than a scheduled crawl. Registered definitions, discovery policies,
plugins and the registry are frozen.

## Category evidence and shop policy

Category classification remains deterministic and evidence-based. Do not add shop/model branches to
the shared taxonomy and do not encode seller merchandising buckets as canonical categories unless the
seller label is authoritative.

Seller-category policy may be `authoritative`, `corroborative`, or `ignore`. Detail enrichment via
`extractDetailCategoryEvidence()` is optional and should return product-specific evidence, not make the
final category decision. Detail requests are bounded by the platform and only unresolved products need
them.

`other` and `unclassified` are different. `other` is a confirmed canonical category; `unclassified`
means evidence is insufficient. Candidate categories from unresolved products must not leak into
canonical category filters.

## Shop-specific metadata

Shop-specific factual fields belong in `metadata`, not new `products` columns:

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

Only factual seller information belongs here. Do not copy descriptions, staff comments, images, or
other editorial content.

## Before enabling a collector

1. Replace the generated fixture with representative sanitized listing HTML: normal, sold,
   negotiating/unknown, pagination termination, malformed/empty page.
2. Implement `discovery.initialTargets()`, optional `discoverTargets()`, and choose explicit coverage.
3. Implement `parse()` returning the complete `SellerProduct` contract including raw fields.
4. Map seller availability to the canonical tri-state and test contradictory/uncertain cases.
5. Define seller-category mapping/policy and optional detail evidence where listing evidence is weak.
6. Add parser assertions for raw fields, availability, classification and factual metadata.
7. Run `npm run format`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`,
   `npm run docs:architecture:check`, and `npm run build`.
8. Check robots.txt and the site's current terms.
9. Declare the shop's `<PREFIX>_*` values in `wrangler.jsonc`; relay collectors also require
   `CRAWL_RELAY_URL` and `CRAWL_RELAY_TOKEN`.
10. Remove `defaultEnabled: false` only after the implementation and CI are green.
