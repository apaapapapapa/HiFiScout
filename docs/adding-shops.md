# Adding a shop

A shop is a plugin, not a change to the crawler. Discovery, transport, normalization, identity,
persistence, search projection, product search grouping, evidence, and data quality are platform
behavior. A shop contributes only definition metadata, a discovery policy, seller-fact parsing,
availability mapping, optional capabilities, fixtures, and tests.

Adding a normal shop must not require editing `run.ts`, `dispatch.ts`, a repository, or a shop-name
type union in `src/crawler/types.ts`.

Use the scaffold generator:

```bash
vp run create-shop \
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
  policy: {
    emptyPage: "stop" | "continue";
    itemCountValidation: "coverage" | "always";
    extraPageBudget: number;
  };
  initialTargets(context: DiscoveryContext): Iterable<TPage>;
  discoverTargets?(html: string, page: TPage): readonly C... (truncated)