from pathlib import Path

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    text = read(path)
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f'{path}: expected {count} occurrence(s), found {actual}: {old[:120]!r}')
    write(path, text.replace(old, new))


# ---------------------------------------------------------------------------
# Catalog vocabulary: remove legacy shop-shaped inputs/adapters.
# ---------------------------------------------------------------------------
replace(
    'src/catalog/types.ts',
    '''  /** Legacy compatibility flag; only the exact value `"prefer"` has an effect. */\n  readonly titleInference?: string;\n''',
    '',
)
replace(
    'src/catalog/types.ts',
    '''/**\n * The slice of a shop adapter the catalog layer reads. Declared here (rather than importing\n * `ShopAdapter` from the crawler) so this module stays a leaf.\n */\nexport interface CatalogAdapterLike {\n  readonly key?: string;\n  readonly categoryMapping?: CategoryMapping;\n  readonly categoryPolicy?: CategoryPolicyInput;\n}\n\n''',
    '''/** Catalog-owned normalization configuration supplied by the shop composition boundary. */\nexport interface CategoryNormalizationConfig {\n  readonly categoryMapping?: CategoryMapping;\n  readonly categoryPolicy?: CategoryPolicyInput;\n}\n\n''',
)
replace(
    'src/catalog/types.ts',
    '  adapter?: CatalogAdapterLike;\n',
    '  categoryPolicy?: CategoryPolicyInput;\n',
)
replace(
    'src/catalog/types.ts',
    '''/**\n * Stage 1 — what a shop adapter's `parse()` returns, before normalization.\n *\n * `metadata`/`featureFacts`/`categoryEvidence`/`sourcePublishedAt`/`rawManufacturer`/\n * `rawCategory`/`category` are optional because adapters are heterogeneous: `parser.ts`\n * output and `ippinkan` omit several of them, and tests assert the exact key set of a\n * parsed product, so absent must stay absent (never `key: undefined`).\n */\nexport interface ShopParsedProduct {\n''',
    '''/**\n * Catalog normalization input. Seller adapters use the stricter crawler-owned `SellerProduct`\n * contract; other catalog callers may omit raw evidence that is unavailable to them.\n */\nexport interface CatalogNormalizationInput {\n''',
)
replace(
    'src/catalog/types.ts',
    ''' * Stage 2 — `normalizeCatalogProduct()` output. This is what the crawler, the category\n * enricher and every repository see; `defineShopPlugin` guarantees `plugin.parse()`\n * returns this, never `ShopParsedProduct`.\n''',
    ''' * Stage 2 — `normalizeCatalogProduct()` output. This is what the crawler, the category\n * enricher and every repository see; `defineShopPlugin` guarantees `plugin.parse()`\n * returns this, never an unnormalized seller product.\n''',
)

replace(
    'src/catalog/category-evidence.ts',
    '''  CatalogAdapterLike,\n''',
    '''  CategoryPolicyInput,\n''',
)
replace(
    'src/catalog/category-evidence.ts',
    '''export function resolveCategoryPolicy(adapter: CatalogAdapterLike = {}): ResolvedCategoryPolicy {\n  const requested = adapter.categoryPolicy || {};\n  const seller = requested.sellerCategory || {};\n  const legacyPrefer = requested.titleInference === "prefer";\n  return {\n    sellerCategory: {\n      default: mode(seller.default, legacyPrefer ? "corroborative" : "authoritative"),\n''',
    '''export function resolveCategoryPolicy(\n  requested: CategoryPolicyInput = {},\n): ResolvedCategoryPolicy {\n  const seller = requested.sellerCategory || {};\n  return {\n    sellerCategory: {\n      default: mode(seller.default, "authoritative"),\n''',
)
replace(
    'src/catalog/category-evidence.ts',
    '''  adapter = {},\n}: CollectListingCategoryEvidenceOptions = {}): ListingCategoryEvidence {\n  const policy = resolveCategoryPolicy(adapter);\n''',
    '''  categoryPolicy = {},\n}: CollectListingCategoryEvidenceOptions = {}): ListingCategoryEvidence {\n  const policy = resolveCategoryPolicy(categoryPolicy);\n''',
)

replace(
    'src/catalog/product-normalizer.ts',
    '''  CatalogAdapterLike,\n''',
    '''  CatalogNormalizationInput,\n  CategoryNormalizationConfig,\n''',
)
replace('src/catalog/product-normalizer.ts', '  ShopParsedProduct,\n', '')
replace(
    'src/catalog/product-normalizer.ts',
    '''export function normalizeCatalogProduct(\n  product: ShopParsedProduct,\n  adapter: CatalogAdapterLike = {},\n): NormalizedCatalogProduct {\n''',
    '''export function normalizeCatalogProduct(\n  product: CatalogNormalizationInput,\n  config: CategoryNormalizationConfig = {},\n): NormalizedCatalogProduct {\n''',
)
replace(
    'src/catalog/product-normalizer.ts',
    '''    categoryMapping: adapter.categoryMapping || {},\n    adapter,\n''',
    '''    categoryMapping: config.categoryMapping || {},\n    categoryPolicy: config.categoryPolicy,\n''',
)
replace(
    'src/catalog/product-normalizer.ts',
    '''export function normalizeCatalogProducts(\n  products: readonly ShopParsedProduct[],\n  adapter: CatalogAdapterLike = {},\n): NormalizedCatalogProduct[] {\n  return products.map((product) => normalizeCatalogProduct(product, adapter));\n}\n''',
    '''export function normalizeCatalogProducts(\n  products: readonly CatalogNormalizationInput[],\n  config: CategoryNormalizationConfig = {},\n): NormalizedCatalogProduct[] {\n  return products.map((product) => normalizeCatalogProduct(product, config));\n}\n''',
)

# ---------------------------------------------------------------------------
# Crawler contract: minimal adapter, explicit capabilities and typed discovery policy.
# ---------------------------------------------------------------------------
replace('src/crawler/types.ts', '  ShopParsedProduct,\n', '  FeatureFactInput,\n')
replace(
    'src/crawler/types.ts',
    '''import type {\n  IdentitySyncMetrics,\n''',
    '''import type { ProductActivityPolicy } from "../db/product-activity-policy.js";\nimport type {\n  IdentitySyncMetrics,\n''',
)
replace(
    'src/crawler/types.ts',
    '''/** A definition as a shop writes it; `envPrefix` is derived unless explicitly overridden. */\nexport type ShopDefinitionInput = Omit<ShopDefinition, "envPrefix"> & {\n  readonly envPrefix?: string;\n};\n''',
    '''/** A definition as a shop writes it; `envPrefix` is always derived from the shop key. */\nexport type ShopDefinitionInput = Omit<ShopDefinition, "envPrefix">;\n''',
)
replace(
    'src/crawler/types.ts',
    '''export interface DiscoveryCapability<TPage extends CrawlPage = CrawlPage> {\n  readonly coverage: CoverageKind;\n  readonly continueOnEmpty?: boolean;\n  readonly guardItemCount?: boolean;\n  readonly extraPageAllowance?: number;\n  initialTargets(context: DiscoveryContext): Iterable<TPage>;\n''',
    '''export type EmptyPageAction = "stop" | "continue";\nexport type ItemCountValidationMode = "coverage" | "always";\n\nexport interface DiscoveryPolicy {\n  readonly emptyPage: EmptyPageAction;\n  readonly itemCountValidation: ItemCountValidationMode;\n  readonly extraPageBudget: number;\n}\n\nexport interface DiscoveryCapability<TPage extends CrawlPage = CrawlPage> {\n  readonly coverage: CoverageKind;\n  readonly policy: Readonly<DiscoveryPolicy>;\n  initialTargets(context: DiscoveryContext): Iterable<TPage>;\n''',
)
replace(
    'src/crawler/types.ts',
    '''/**\n * The strict seller-fact shape every shop parser must produce before central catalog\n * normalization. The legacy catalog input keeps these raw fields optional for non-crawler callers;\n * the shop platform does not.\n */\nexport interface SellerProduct extends Omit<\n  ShopParsedProduct,\n  "rawManufacturer" | "rawCategory" | "category"\n> {\n  rawManufacturer: string;\n  rawCategory: string;\n  category: string;\n}\n''',
    '''/** The strict seller-fact shape every shop parser must produce before catalog normalization. */\nexport interface SellerProduct {\n  sourceId: string;\n  manufacturer: string;\n  rawManufacturer: string;\n  model: string;\n  title: string;\n  rawCategory: string;\n  /** Parser hint (a display label), not a category id. */\n  category: string;\n  conditionText: string;\n  priceYen: number | null;\n  stockStatus: StockStatus;\n  sourceUrl: string;\n  sourcePublishedAt?: string | null;\n  metadata?: Record<string, unknown>;\n  featureFacts?: FeatureFactInput[];\n  categoryEvidence?: CategoryEvidenceInput[];\n}\n''',
)
replace(
    'src/crawler/types.ts',
    '''/** Seller-specific diagnostic metadata. Generic orchestration treats the result as opaque. */\nexport interface PageDiagnosticsCapability<TPage extends CrawlPage = CrawlPage> {\n''',
    '''export interface TransportCapability {\n  readonly kind: TransportKind;\n}\n\n/** Catalog normalization hints owned by one seller but interpreted by shared catalog code. */\nexport interface CatalogCapability {\n  readonly categoryMapping?: CategoryMapping;\n  readonly categoryPolicy?: CategoryPolicyInput;\n}\n\n/** Optional seller-specific detail-page evidence extraction. */\nexport interface DetailCategoryEvidenceCapability {\n  extract(\n    html: string,\n    product: NormalizedCatalogProduct,\n  ): CategoryEvidenceInput[] | Promise<CategoryEvidenceInput[]>;\n}\n\n/** Seller-specific diagnostic metadata. Generic orchestration treats the result as opaque. */\nexport interface PageDiagnosticsCapability<TPage extends CrawlPage = CrawlPage> {\n''',
)
replace(
    'src/crawler/types.ts',
    '''export interface ShopRuntimeCapabilities<TPage extends CrawlPage = CrawlPage> {\n  readonly diagnostics?: Readonly<PageDiagnosticsCapability<TPage>>;\n  readonly dataQuality?: Readonly<DataQualityCapability>;\n}\n''',
    '''export interface ShopRuntimeCapabilities<TPage extends CrawlPage = CrawlPage> {\n  readonly transport?: Readonly<TransportCapability>;\n  readonly catalog?: Readonly<CatalogCapability>;\n  readonly detailCategoryEvidence?: Readonly<DetailCategoryEvidenceCapability>;\n  readonly inventoryRecheck?: Readonly<InventoryRecheckPolicy>;\n  readonly diagnostics?: Readonly<PageDiagnosticsCapability<TPage>>;\n  readonly dataQuality?: Readonly<DataQualityCapability>;\n  readonly activityPolicy?: Readonly<ProductActivityPolicy>;\n}\n''',
)
replace(
    'src/crawler/types.ts',
    '''  /** Defaults to `"direct"` when absent. */\n  readonly transport?: TransportKind;\n  readonly requestDelayMs?: number;\n  readonly categoryMapping?: CategoryMapping;\n  readonly categoryPolicy?: CategoryPolicyInput;\n\n  extractDetailCategoryEvidence?(\n    html: string,\n    product: NormalizedCatalogProduct,\n  ): CategoryEvidenceInput[] | Promise<CategoryEvidenceInput[]>;\n\n  /** Opt-in single-listing inventory recheck, run after this shop's crawl succeeds. */\n  readonly inventoryRecheck?: InventoryRecheckPolicy;\n\n  isConfigured?(env: CrawlerEnv): boolean;\n\n  /** Present only after `defineShopPlugin`; see `ShopPlugin`. */\n  readonly definition?: Readonly<ShopDefinition>;\n''',
    '',
)
replace(
    'src/crawler/types.ts',
    '''export interface ShopPlugin<TPage extends CrawlPage = CrawlPage> extends Omit<\n  ShopAdapter<TPage>,\n  "parse" | "definition"\n> {\n''',
    '''export interface ShopPlugin<TPage extends CrawlPage = CrawlPage> extends Omit<\n  ShopAdapter<TPage>,\n  "parse"\n> {\n''',
)

# ---------------------------------------------------------------------------
# Registry/composition: no env-prefix override, no hidden WeakMap capabilities.
# ---------------------------------------------------------------------------
replace(
    'src/crawler/shops/registry.ts',
    '''  ShopRuntimeCapabilities,\n  TransportKind,\n''',
    '''  ShopRuntimeCapabilities,\n  TransportKind,\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''import {\n  DEFAULT_PRODUCT_ACTIVITY_POLICY,\n  type ProductActivityPolicy,\n} from "../../db/product-activity-policy.js";\n\n/** Behaviors a shop opts into at composition time rather than through the adapter contract. */\nexport interface ShopPluginCapabilities<\n  TPage extends CrawlPage = CrawlPage,\n> extends ShopRuntimeCapabilities<TPage> {\n  readonly activityPolicy?: Readonly<ProductActivityPolicy>;\n}\n\nconst SHOP_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;\nconst ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;\n''',
    '''import { DEFAULT_PRODUCT_ACTIVITY_POLICY } from "../../db/product-activity-policy.js";\n\nconst SHOP_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''const activityPolicies = new WeakMap<ShopPlugin, Readonly<ProductActivityPolicy>>();\n\n''',
    '',
)
replace(
    'src/crawler/shops/registry.ts',
    '''function assertNonNegativeInt(key: string, field: string, value: number | undefined): void {\n  if (value === undefined) return;\n  if (!Number.isInteger(value) || value < 0) {\n    invalid(key, `${field} must be a non-negative integer`);\n  }\n}\n''',
    '''function assertNonNegativeInt(key: string, field: string, value: number): void {\n  if (!Number.isInteger(value) || value < 0) {\n    invalid(key, `${field} must be a non-negative integer`);\n  }\n}\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''  if (discovery.discoverTargets !== undefined && typeof discovery.discoverTargets !== "function") {\n    invalid(key, "discovery.discoverTargets must be a function when present");\n  }\n  assertNonNegativeInt(key, "discovery.extraPageAllowance", discovery.extraPageAllowance);\n}\n''',
    '''  if (discovery.discoverTargets !== undefined && typeof discovery.discoverTargets !== "function") {\n    invalid(key, "discovery.discoverTargets must be a function when present");\n  }\n  if (!discovery.policy) invalid(key, "discovery.policy is required");\n  if (discovery.policy.emptyPage !== "stop" && discovery.policy.emptyPage !== "continue") {\n    invalid(key, `discovery.policy.emptyPage ${String(discovery.policy.emptyPage)} is invalid`);\n  }\n  if (\n    discovery.policy.itemCountValidation !== "coverage" &&\n    discovery.policy.itemCountValidation !== "always"\n  ) {\n    invalid(\n      key,\n      `discovery.policy.itemCountValidation ${String(discovery.policy.itemCountValidation)} is invalid`,\n    );\n  }\n  assertNonNegativeInt(key, "discovery.policy.extraPageBudget", discovery.policy.extraPageBudget);\n}\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''  const envPrefix = input.envPrefix || deriveEnvPrefix(key);\n  if (!ENV_PREFIX_PATTERN.test(envPrefix)) {\n    invalid(key, `envPrefix must be SCREAMING_SNAKE_CASE: ${envPrefix}`);\n  }\n\n''',
    '''  const envPrefix = deriveEnvPrefix(key);\n\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''  if (adapter.transport !== undefined && !SUPPORTED_TRANSPORTS[adapter.transport]) {\n    invalid(key, `transport ${adapter.transport} is not a supported transport`);\n  }\n\n  return Object.freeze({ ...input, envPrefix });\n}\n\n/** Compose one concrete adapter into a frozen registered plugin. */\nexport function defineShopPlugin<TPage extends CrawlPage>(\n  adapter: ShopAdapter<TPage>,\n  definition: ShopDefinitionInput,\n  capabilities: ShopPluginCapabilities<TPage> = {},\n): ShopPlugin<TPage> {\n''',
    '''  return Object.freeze({ ...input, envPrefix });\n}\n\nfunction validateCapabilities<TPage extends CrawlPage>(\n  key: string,\n  definition: ShopDefinitionInput,\n  capabilities: ShopRuntimeCapabilities<TPage>,\n): void {\n  const transport = capabilities.transport?.kind;\n  if (transport !== undefined && !SUPPORTED_TRANSPORTS[transport]) {\n    invalid(key, `transport ${transport} is not a supported transport`);\n  }\n  if (definition.transportConfigurationRequired === true && transport !== "relay") {\n    invalid(key, "transportConfigurationRequired requires relay transport");\n  }\n}\n\n/** Compose one concrete adapter into a frozen registered plugin. */\nexport function defineShopPlugin<TPage extends CrawlPage>(\n  adapter: ShopAdapter<TPage>,\n  definition: ShopDefinitionInput,\n  capabilities: ShopRuntimeCapabilities<TPage> = {},\n): ShopPlugin<TPage> {\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''  const validated = validatedDefinition(adapter, definition);\n  const parse = adapter.parse;\n  const discovery = Object.freeze({ ...adapter.discovery });\n  const runtimeCapabilities: Readonly<ShopRuntimeCapabilities<TPage>> = Object.freeze({\n    diagnostics: capabilities.diagnostics\n      ? Object.freeze({ ...capabilities.diagnostics })\n      : undefined,\n    dataQuality: capabilities.dataQuality\n      ? Object.freeze({\n          ...capabilities.dataQuality,\n          thresholds: capabilities.dataQuality.thresholds\n            ? Object.freeze({ ...capabilities.dataQuality.thresholds })\n            : undefined,\n        })\n      : undefined,\n  });\n''',
    '''  const validated = validatedDefinition(adapter, definition);\n  validateCapabilities(adapter.key, definition, capabilities);\n  const parse = adapter.parse;\n  const discovery = Object.freeze({\n    ...adapter.discovery,\n    policy: Object.freeze({ ...adapter.discovery.policy }),\n  });\n  const runtimeCapabilities: Readonly<ShopRuntimeCapabilities<TPage>> = Object.freeze({\n    transport: capabilities.transport ? Object.freeze({ ...capabilities.transport }) : undefined,\n    catalog: capabilities.catalog\n      ? Object.freeze({\n          ...capabilities.catalog,\n          categoryMapping: capabilities.catalog.categoryMapping\n            ? Object.freeze({ ...capabilities.catalog.categoryMapping })\n            : undefined,\n          categoryPolicy: capabilities.catalog.categoryPolicy\n            ? Object.freeze({ ...capabilities.catalog.categoryPolicy })\n            : undefined,\n        })\n      : undefined,\n    detailCategoryEvidence: capabilities.detailCategoryEvidence\n      ? Object.freeze({ ...capabilities.detailCategoryEvidence })\n      : undefined,\n    inventoryRecheck: capabilities.inventoryRecheck\n      ? Object.freeze({ ...capabilities.inventoryRecheck })\n      : undefined,\n    diagnostics: capabilities.diagnostics\n      ? Object.freeze({ ...capabilities.diagnostics })\n      : undefined,\n    dataQuality: capabilities.dataQuality\n      ? Object.freeze({\n          ...capabilities.dataQuality,\n          thresholds: capabilities.dataQuality.thresholds\n            ? Object.freeze({ ...capabilities.dataQuality.thresholds })\n            : undefined,\n        })\n      : undefined,\n    activityPolicy: capabilities.activityPolicy\n      ? Object.freeze({ ...capabilities.activityPolicy })\n      : undefined,\n  });\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''      return normalizeCatalogProducts(sellerProducts, plugin);\n''',
    '''      return normalizeCatalogProducts(sellerProducts, runtimeCapabilities.catalog || {});\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''  const frozenPlugin = Object.freeze(plugin);\n  activityPolicies.set(\n    frozenPlugin,\n    capabilities.activityPolicy || DEFAULT_PRODUCT_ACTIVITY_POLICY,\n  );\n\n  return frozenPlugin;\n''',
    '''  return Object.freeze(plugin);\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''  const seenPrefixes = new Map<string, string>();\n''',
    '',
)
replace(
    'src/crawler/shops/registry.ts',
    '''    const { key, envPrefix, scheduleCron } = plugin.definition;\n''',
    '''    const { key, scheduleCron } = plugin.definition;\n''',
)
replace(
    'src/crawler/shops/registry.ts',
    '''    const prefixOwner = seenPrefixes.get(envPrefix);\n    if (prefixOwner) {\n      throw new Error(`shops ${prefixOwner} and ${key} share the env prefix ${envPrefix}`);\n    }\n    seenPrefixes.set(envPrefix, key);\n\n''',
    '',
)
replace(
    'src/crawler/shops/registry.ts',
    '''export function getShopActivityPolicy(plugin: ShopPlugin): Readonly<ProductActivityPolicy> {\n  return activityPolicies.get(plugin) || DEFAULT_PRODUCT_ACTIVITY_POLICY;\n}\n''',
    '''export function getShopActivityPolicy(plugin: ShopPlugin) {\n  return plugin.capabilities.activityPolicy || DEFAULT_PRODUCT_ACTIVITY_POLICY;\n}\n''',
)

# ---------------------------------------------------------------------------
# Discovery strategy uses one typed policy object.
# ---------------------------------------------------------------------------
replace(
    'src/crawler/strategies.ts',
    '''export interface CoverageDecision {\n  deactivateMissing: boolean;\n  guardItemCount: boolean;\n}\n''',
    '''export interface CoverageDecision {\n  deactivateMissing: boolean;\n  validateItemCount: boolean;\n}\n''',
)
replace(
    'src/crawler/strategies.ts',
    '''  const allowance = Math.max(0, adapter.discovery.extraPageAllowance || 0);\n''',
    '''  const allowance = adapter.discovery.policy.extraPageBudget;\n''',
)
replace(
    'src/crawler/strategies.ts',
    '''  return adapter.discovery.continueOnEmpty === true;\n''',
    '''  return adapter.discovery.policy.emptyPage === "continue";\n''',
)
replace(
    'src/crawler/strategies.ts',
    '''    guardItemCount: deactivateMissing || adapter.discovery.guardItemCount === true,\n''',
    '''    validateItemCount:\n      deactivateMissing || adapter.discovery.policy.itemCountValidation === "always",\n''',
)

# ---------------------------------------------------------------------------
# Transport consumes a transport kind, never adapter-shaped compatibility.
# ---------------------------------------------------------------------------
replace(
    'src/crawler/transport.ts',
    '''  RelayFetcherConfig,\n  ShopAdapter,\n} from "./types.js";\n''',
    '''  RelayFetcherConfig,\n  TransportKind,\n} from "./types.js";\n''',
)
replace(
    'src/crawler/transport.ts',
    '''/** Only the transport selector is read, so callers may pass any adapter-shaped object. */\ntype TransportSelector = Pick<ShopAdapter, "transport">;\n\n''',
    '',
)
replace(
    'src/crawler/transport.ts',
    '''  adapter: TransportSelector | undefined,\n): boolean {\n  if (adapter?.transport !== "relay") return true;\n''',
    '''  transport: TransportKind | undefined,\n): boolean {\n  if (transport !== "relay") return true;\n''',
)
replace(
    'src/crawler/transport.ts',
    '''  adapter: TransportSelector | undefined,\n  fetchFn: typeof fetch = fetch,\n): HtmlTransport {\n  if (adapter?.transport === "browser") return createBrowserHtmlFetcher(env.BROWSER);\n  if (adapter?.transport === "relay") {\n''',
    '''  transport: TransportKind | undefined,\n  fetchFn: typeof fetch = fetch,\n): HtmlTransport {\n  if (transport === "browser") return createBrowserHtmlFetcher(env.BROWSER);\n  if (transport === "relay") {\n''',
)

# ---------------------------------------------------------------------------
# Generic lifecycle reads capabilities only.
# ---------------------------------------------------------------------------
replace(
    'src/crawler/run.ts',
    '''function isConfigured(env: CrawlerEnv, adapter: ShopPlugin): boolean {\n  if (!isTransportConfigured(env, adapter)) return false;\n  if (adapter.transport === "relay") return true;\n  return !adapter.isConfigured || adapter.isConfigured(env);\n}\n''',
    '''function isConfigured(env: CrawlerEnv, adapter: ShopPlugin): boolean {\n  return isTransportConfigured(env, adapter.capabilities.transport?.kind);\n}\n''',
)
replace(
    'src/crawler/run.ts',
    '''  const pageLimit = maxPages + Math.max(0, adapter.discovery.extraPageAllowance || 0);\n''',
    '''  const pageLimit = maxPages + adapter.discovery.policy.extraPageBudget;\n''',
)
replace(
    'src/crawler/run.ts',
    '''  const transport = createTransport(env, adapter, fetchFn);\n''',
    '''  const transport = createTransport(env, adapter.capabilities.transport?.kind, fetchFn);\n''',
)
replace(
    'src/crawler/run.ts',
    '''    const { deactivateMissing, guardItemCount } = coverageDecision(adapter, {\n''',
    '''    const { deactivateMissing, validateItemCount } = coverageDecision(adapter, {\n''',
)
replace(
    'src/crawler/run.ts',
    '''      guardItemCount &&\n''',
    '''      validateItemCount &&\n''',
)

replace(
    'src/crawler/dispatch.ts',
    '''function isConfigured(env: CrawlerEnv, plugin: ShopPlugin): boolean {\n  if (!isTransportConfigured(env, plugin)) return false;\n  if (plugin.transport === "relay") return true;\n  return !plugin.isConfigured || plugin.isConfigured(env);\n}\n''',
    '''function isConfigured(env: CrawlerEnv, plugin: ShopPlugin): boolean {\n  return isTransportConfigured(env, plugin.capabilities.transport?.kind);\n}\n''',
)
replace(
    'src/crawler/dispatch.ts',
    '''  if (crawlResult.status !== "success" || !plugin.inventoryRecheck) return crawlResult;\n''',
    '''  if (crawlResult.status !== "success" || !plugin.capabilities.inventoryRecheck) {\n    return crawlResult;\n  }\n''',
)
replace(
    'src/crawler/inventory-recheck.ts',
    ''' * guard and availability classifier from the adapter's {@link InventoryRecheckPolicy}.\n''',
    ''' * guard and availability classifier from the plugin's inventory-recheck capability.\n''',
)
replace(
    'src/crawler/inventory-recheck.ts',
    '''  const policy = plugin.inventoryRecheck;\n''',
    '''  const policy = plugin.capabilities.inventoryRecheck;\n''',
)

replace(
    'src/crawler/category-enricher.ts',
    '''  ShopAdapter,\n} from "./types.js";\n\ntype CategoryEnrichmentAdapter = Pick<\n  ShopAdapter,\n  "key" | "categoryMapping" | "categoryPolicy" | "extractDetailCategoryEvidence"\n>;\n''',
    '''  ShopPlugin,\n} from "./types.js";\n\ntype CategoryEnrichmentAdapter = Pick<ShopPlugin, "key" | "capabilities">;\n''',
)
replace(
    'src/crawler/category-enricher.ts',
    '''  const extractor = adapter?.extractDetailCategoryEvidence;\n  if (typeof extractor !== "function") {\n''',
    '''  const extractor = adapter.capabilities.detailCategoryEvidence?.extract;\n  if (typeof extractor !== "function") {\n''',
)
replace(
    'src/crawler/category-enricher.ts',
    '''  const policy = resolveCategoryPolicy(adapter);\n''',
    '''  const policy = resolveCategoryPolicy(adapter.capabilities.catalog?.categoryPolicy);\n''',
)
replace(
    'src/crawler/category-enricher.ts',
    '''      const detailEvidence = await extractor.call(adapter, html, product);\n''',
    '''      const detailEvidence = await extractor(html, product);\n''',
)

# ---------------------------------------------------------------------------
# Concrete shops: only universal adapter fields remain; capabilities move to index.ts.
# ---------------------------------------------------------------------------
replace('src/crawler/shops/audiounion.ts', 'import { audioUnionInventoryRecheck } from "./audiounion-inventory.js";\n', '')
replace(
    'src/crawler/shops/audiounion.ts',
    '''  transport: "relay",\n  requestDelayMs: 10_000,\n  inventoryRecheck: audioUnionInventoryRecheck,\n  discovery: {\n    coverage: "partial",\n''',
    '''  discovery: {\n    coverage: "partial",\n    policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },\n''',
)

replace(
    'src/crawler/shops/ippinkan.ts',
    '''    coverage: "unknown",\n    *initialTargets''',
    '''    coverage: "unknown",\n    policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },\n    *initialTargets''',
)

replace(
    'src/crawler/shops/fujiya-avic.ts',
    '''export const fujiyaAvicAdapter = {\n''',
    '''export const FUJIYA_CATEGORY_POLICY = Object.freeze({\n  sellerCategory: Object.freeze({\n    default: "authoritative" as const,\n    categories: Object.freeze({\n      dap: "corroborative" as const,\n      headphone_amp: "corroborative" as const,\n    }),\n  }),\n  parserHint: "corroborative" as const,\n  enrichment: Object.freeze({\n    maxRequestsPerCrawl: 20,\n    cacheHours: 168,\n  }),\n});\n\nexport const fujiyaAvicAdapter = {\n''',
)
replace(
    'src/crawler/shops/fujiya-avic.ts',
    '''  categoryPolicy: Object.freeze({\n    sellerCategory: Object.freeze({\n      default: "authoritative",\n      categories: Object.freeze({\n        dap: "corroborative",\n        headphone_amp: "corroborative",\n      }),\n    }),\n    parserHint: "corroborative",\n    enrichment: Object.freeze({\n      maxRequestsPerCrawl: 20,\n      cacheHours: 168,\n    }),\n  }),\n  extractDetailCategoryEvidence: extractFujiyaDetailCategoryEvidence,\n  discovery: {\n    // New arrivals and outlet feeds are intentionally bounded subsets of total inventory.\n    coverage: "partial",\n    continueOnEmpty: true,\n''',
    '''  discovery: {\n    // New arrivals and outlet feeds are intentionally bounded subsets of total inventory.\n    coverage: "partial",\n    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },\n''',
)

replace('src/crawler/shops/hifido.ts', 'const HIFIDO_CATEGORY_MAPPING = Object.freeze({\n', 'export const HIFIDO_CATEGORY_MAPPING = Object.freeze({\n')
replace(
    'src/crawler/shops/hifido.ts',
    '''  categoryMapping: HIFIDO_CATEGORY_MAPPING,\n  transport: "relay",\n  discovery: {\n    coverage: "partial",\n    guardItemCount: true,\n    continueOnEmpty: true,\n    extraPageAllowance: 1,\n''',
    '''  discovery: {\n    coverage: "partial",\n    policy: { emptyPage: "continue", itemCountValidation: "always", extraPageBudget: 1 },\n''',
)

replace('src/crawler/shops/formusic.ts', 'const FORMUSIC_CATEGORY_MAPPING = Object.freeze({\n', 'export const FORMUSIC_CATEGORY_MAPPING = Object.freeze({\n')
replace(
    'src/crawler/shops/formusic.ts',
    '''  categoryMapping: FORMUSIC_CATEGORY_MAPPING,\n  discovery: {\n    coverage: "complete",\n''',
    '''  discovery: {\n    coverage: "complete",\n    policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },\n''',
)

replace('src/crawler/shops/u-audio.ts', 'const U_AUDIO_CATEGORY_MAPPING = Object.freeze({\n', 'export const U_AUDIO_CATEGORY_MAPPING = Object.freeze({\n')
replace(
    'src/crawler/shops/u-audio.ts',
    '''export const uAudioAdapter = {\n''',
    '''export const U_AUDIO_CATEGORY_POLICY = Object.freeze({\n  sellerCategory: Object.freeze({ default: "authoritative" as const }),\n  parserHint: "corroborative" as const,\n});\n\nexport const uAudioAdapter = {\n''',
)
replace(
    'src/crawler/shops/u-audio.ts',
    '''  categoryMapping: U_AUDIO_CATEGORY_MAPPING,\n  categoryPolicy: Object.freeze({\n    sellerCategory: Object.freeze({ default: "authoritative" }),\n    parserHint: "corroborative",\n  }),\n  discovery: {\n    coverage: "complete",\n    continueOnEmpty: true,\n''',
    '''  discovery: {\n    coverage: "complete",\n    policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },\n''',
)

replace(
    'src/crawler/shops/shimamusen.ts',
    '''export const shimamusenAdapter = {\n''',
    '''export const SHIMAMUSEN_CATEGORY_POLICY = Object.freeze({\n  sellerCategory: Object.freeze({ default: "ignore" as const }),\n  parserHint: "ignore" as const,\n});\n\nexport const shimamusenAdapter = {\n''',
)
replace(
    'src/crawler/shops/shimamusen.ts',
    '''  categoryPolicy: {\n    sellerCategory: { default: "ignore" },\n    parserHint: "ignore",\n  },\n  discovery: {\n    coverage: "complete",\n    guardItemCount: true,\n''',
    '''  discovery: {\n    coverage: "complete",\n    policy: { emptyPage: "stop", itemCountValidation: "always", extraPageBudget: 0 },\n''',
)

# Composition root imports/configuration.
replace(
    'src/crawler/shops/index.ts',
    '''import { audioUnionAdapter } from "./audiounion.js";\nimport { diagnoseAudioUnionHtml } from "./audiounion-diagnostics.js";\nimport { ippinkanAdapter } from "./ippinkan.js";\nimport { fujiyaAvicAdapter } from "./fujiya-avic.js";\nimport { hifidoAdapter } from "./hifido.js";\nimport { forMusicAdapter } from "./formusic.js";\nimport { uAudioAdapter } from "./u-audio.js";\nimport { shimamusenAdapter } from "./shimamusen.js";\n''',
    '''import { audioUnionAdapter } from "./audiounion.js";\nimport { diagnoseAudioUnionHtml } from "./audiounion-diagnostics.js";\nimport { audioUnionInventoryRecheck } from "./audiounion-inventory.js";\nimport { ippinkanAdapter } from "./ippinkan.js";\nimport { FUJIYA_CATEGORY_POLICY, extractFujiyaDetailCategoryEvidence, fujiyaAvicAdapter } from "./fujiya-avic.js";\nimport { HIFIDO_CATEGORY_MAPPING, hifidoAdapter } from "./hifido.js";\nimport { FORMUSIC_CATEGORY_MAPPING, forMusicAdapter } from "./formusic.js";\nimport { U_AUDIO_CATEGORY_MAPPING, U_AUDIO_CATEGORY_POLICY, uAudioAdapter } from "./u-audio.js";\nimport { SHIMAMUSEN_CATEGORY_POLICY, shimamusenAdapter } from "./shimamusen.js";\n''',
)
replace(
    'src/crawler/shops/index.ts',
    '''    { diagnostics: { diagnosePage: diagnoseAudioUnionHtml } },\n''',
    '''    {\n      transport: { kind: "relay" },\n      inventoryRecheck: audioUnionInventoryRecheck,\n      diagnostics: { diagnosePage: diagnoseAudioUnionHtml },\n    },\n''',
)
replace(
    'src/crawler/shops/index.ts',
    '''  defineShopPlugin(fujiyaAvicAdapter, {\n    key: "fujiya-avic",\n    name: "フジヤエービック",\n    baseUrl: "https://www.fujiya-avic.co.jp",\n    defaultIntervalMinutes: 30,\n    defaultMaxPages: 50,\n    scheduleCron: "30 * * * *",\n  }),\n''',
    '''  defineShopPlugin(\n    fujiyaAvicAdapter,\n    {\n      key: "fujiya-avic",\n      name: "フジヤエービック",\n      baseUrl: "https://www.fujiya-avic.co.jp",\n      defaultIntervalMinutes: 30,\n      defaultMaxPages: 50,\n      scheduleCron: "30 * * * *",\n    },\n    {\n      catalog: { categoryPolicy: FUJIYA_CATEGORY_POLICY },\n      detailCategoryEvidence: { extract: extractFujiyaDetailCategoryEvidence },\n    },\n  ),\n''',
)
replace(
    'src/crawler/shops/index.ts',
    '''    { activityPolicy: HIFIDO_ACTIVITY_POLICY },\n''',
    '''    {\n      transport: { kind: "relay" },\n      catalog: { categoryMapping: HIFIDO_CATEGORY_MAPPING },\n      activityPolicy: HIFIDO_ACTIVITY_POLICY,\n    },\n''',
)
replace(
    'src/crawler/shops/index.ts',
    '''  defineShopPlugin(forMusicAdapter, {\n    key: "formusic",\n    name: "FOR MUSIC",\n    baseUrl: "https://shop.formusic.jp",\n    defaultIntervalMinutes: 30,\n  }),\n''',
    '''  defineShopPlugin(\n    forMusicAdapter,\n    {\n      key: "formusic",\n      name: "FOR MUSIC",\n      baseUrl: "https://shop.formusic.jp",\n      defaultIntervalMinutes: 30,\n    },\n    { catalog: { categoryMapping: FORMUSIC_CATEGORY_MAPPING } },\n  ),\n''',
)
replace(
    'src/crawler/shops/index.ts',
    '''  defineShopPlugin(uAudioAdapter, {\n    key: "u-audio",\n    name: "U-AUDIO",\n    baseUrl: "https://www.u-audio.com",\n    // Its deployed variables predate the derived spelling; `U_AUDIO_*` would silently reset the\n    // shop to its defaults.\n    envPrefix: "UAUDIO",\n    defaultIntervalMinutes: 60,\n    defaultMaxPages: 50,\n  }),\n''',
    '''  defineShopPlugin(\n    uAudioAdapter,\n    {\n      key: "u-audio",\n      name: "U-AUDIO",\n      baseUrl: "https://www.u-audio.com",\n      defaultIntervalMinutes: 60,\n      defaultMaxPages: 50,\n    },\n    {\n      catalog: {\n        categoryMapping: U_AUDIO_CATEGORY_MAPPING,\n        categoryPolicy: U_AUDIO_CATEGORY_POLICY,\n      },\n    },\n  ),\n''',
)
replace(
    'src/crawler/shops/index.ts',
    '''  defineShopPlugin(shimamusenAdapter, {\n    key: "shimamusen",\n    name: "シマムセン",\n    baseUrl: "https://www.shimamusen.com",\n    defaultIntervalMinutes: 60,\n    defaultMaxPages: 20,\n  }),\n''',
    '''  defineShopPlugin(\n    shimamusenAdapter,\n    {\n      key: "shimamusen",\n      name: "シマムセン",\n      baseUrl: "https://www.shimamusen.com",\n      defaultIntervalMinutes: 60,\n      defaultMaxPages: 20,\n    },\n    { catalog: { categoryPolicy: SHIMAMUSEN_CATEGORY_POLICY } },\n  ),\n''',
)

# ---------------------------------------------------------------------------
# U-AUDIO canonical env namespace. No fallback or alias remains.
# ---------------------------------------------------------------------------
text = read('wrangler.jsonc').replace('UAUDIO_', 'U_AUDIO_')
write('wrangler.jsonc', text)
text = read('test/dispatch.test.ts').replace('UAUDIO_ENABLED', 'U_AUDIO_ENABLED')
write('test/dispatch.test.ts', text)

# ---------------------------------------------------------------------------
# Generator: transport is a registration capability and discovery policy is explicit.
# ---------------------------------------------------------------------------
replace(
    'scripts/create-shop.ts',
    '''interface AdapterTemplateOptions {\n  key: string;\n  name: string;\n  baseUrl: string;\n  transport?: ShopTransport;\n}\n''',
    '''interface AdapterTemplateOptions {\n  key: string;\n  name: string;\n  baseUrl: string;\n}\n''',
)
replace(
    'scripts/create-shop.ts',
    '''interface PluginRegistrationOptions {\n  key: string;\n  name: string;\n  baseUrl: string;\n  intervalMinutes?: number;\n}\n''',
    '''interface PluginRegistrationOptions {\n  key: string;\n  name: string;\n  baseUrl: string;\n  transport?: ShopTransport;\n  intervalMinutes?: number;\n}\n''',
)
replace(
    'scripts/create-shop.ts',
    '''export function renderAdapter({\n  key,\n  name,\n  baseUrl,\n  transport = "direct",\n}: AdapterTemplateOptions): string {\n''',
    '''export function renderAdapter({ key, name, baseUrl }: AdapterTemplateOptions): string {\n''',
)
replace(
    'scripts/create-shop.ts',
    '''  transport: ${quote(transport)},\n  categoryMapping: {\n    // "ネットワークDAC": ["dac", "network_player"],\n  },\n  discovery: {\n    // Keep the scaffold non-destructive until the seller's coverage semantics are understood.\n    coverage: "unknown",\n''',
    '''  discovery: {\n    // Keep the scaffold non-destructive until the seller's coverage semantics are understood.\n    coverage: "unknown",\n    policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },\n''',
)
replace(
    'scripts/create-shop.ts',
    '''  intervalMinutes = 60,\n}: PluginRegistrationOptions): string {\n''',
    '''  transport = "direct",\n  intervalMinutes = 60,\n}: PluginRegistrationOptions): string {\n''',
)
replace(
    'scripts/create-shop.ts',
    '''    defaultEnabled: false,\n  }),\n`;\n''',
    '''    defaultEnabled: false,\n  }, {\n    transport: { kind: ${quote(transport)} },\n  }),\n`;\n''',
)
replace(
    'scripts/create-shop.ts',
    '''${renderPluginRegistration({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, intervalMinutes })}${PLUGIN_MARKER}`,'',
    '''${renderPluginRegistration({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, transport, intervalMinutes })}${PLUGIN_MARKER}`,'',
)
replace(
    'scripts/create-shop.ts',
    '''      renderAdapter({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, transport }),\n''',
    '''      renderAdapter({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin }),\n''',
)

# ---------------------------------------------------------------------------
# Test helper uses neutral catalog normalization input.
# ---------------------------------------------------------------------------
replace(
    'test/helpers/fixtures.ts',
    'import type { ShopParsedProduct } from "../../src/catalog/types.js";\n',
    'import type { CatalogNormalizationInput } from "../../src/catalog/types.js";\n',
)
replace(
    'test/helpers/fixtures.ts',
    '''  overrides: Partial<ShopParsedProduct> & Pick<ShopParsedProduct, "title">,\n): ShopParsedProduct {\n''',
    '''  overrides: Partial<CatalogNormalizationInput> & Pick<CatalogNormalizationInput, "title">,\n): CatalogNormalizationInput {\n''',
)

# ---------------------------------------------------------------------------
# Focused tests: final contract names and canonical U-AUDIO prefix.
# ---------------------------------------------------------------------------
text = read('test/shop-contract.test.ts')
text = text.replace('  type ShopPluginCapabilities,\n', '')
text = text.replace('  capabilities: ShopPluginCapabilities = {},\n', '  capabilities: ShopRuntimeCapabilities = {},\n')
text = text.replace(
    'import type { ShopAdapter, ShopDefinitionInput, ShopPlugin } from "../src/crawler/types.js";\n',
    'import type { ShopAdapter, ShopDefinitionInput, ShopPlugin, ShopRuntimeCapabilities } from "../src/crawler/types.js";\n',
)
text = text.replace('|| plugin.inventoryRecheck !== undefined', '|| plugin.capabilities.inventoryRecheck !== undefined')
text = text.replace('registerStub({ envPrefix: "example shop" }), /SCREAMING_SNAKE_CASE/);\n', '')
text = text.replace(
    '''  assert.throws(\n    () =>\n      createShopRegistry([\n        registerStub({ key: "one-shop", envPrefix: "SHARED" }),\n        registerStub({ key: "two-shop", envPrefix: "SHARED" }),\n      ]),\n    /share the env prefix/,\n  );\n''',
    '',
)
text = text.replace('  assert.equal(registerStub({ envPrefix: "LEGACY" }).definition.envPrefix, "LEGACY");\n', '')
text = text.replace(
    '''    discovery: {\n      coverage: "unknown",\n      *initialTargets() {},\n    },\n''',
    '''    discovery: {\n      coverage: "unknown",\n      policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },\n      *initialTargets() {},\n    },\n''',
)
text = text.replace(
    '''          discovery: {\n            coverage: "everything" as unknown as "complete",\n            *initialTargets() {},\n          },\n''',
    '''          discovery: {\n            coverage: "everything" as unknown as "complete",\n            policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },\n            *initialTargets() {},\n          },\n''',
)
text = text.replace(
    '''          discovery: {\n            coverage: "unknown",\n            extraPageAllowance: -1,\n            *initialTargets() {},\n          },\n        },\n      ),\n    /extraPageAllowance/,\n  );\n''',
    '''          discovery: {\n            coverage: "unknown",\n            policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: -1 },\n            *initialTargets() {},\n          },\n        },\n      ),\n    /extraPageBudget/,\n  );\n''',
)
text = text.replace('if (plugin.inventoryRecheck !== undefined) {\n      const policy = plugin.inventoryRecheck;', 'if (plugin.capabilities.inventoryRecheck !== undefined) {\n      const policy = plugin.capabilities.inventoryRecheck;')
text = text.replace('{ deactivateMissing: true, guardItemCount: true }', '{ deactivateMissing: true, validateItemCount: true }')
text = text.replace('{ deactivateMissing: false, guardItemCount: true }', '{ deactivateMissing: false, validateItemCount: true }')
text = text.replace('{ deactivateMissing: false, guardItemCount: false }', '{ deactivateMissing: false, validateItemCount: false }')
text = text.replace(
    '{ discovery: { coverage: "partial", guardItemCount: true, *initialTargets() {} } },',
    '{ discovery: { coverage: "partial", policy: { emptyPage: "stop", itemCountValidation: "always", extraPageBudget: 0 }, *initialTargets() {} } },',
)
write('test/shop-contract.test.ts', text)

# Hifido/Fujiya focused expectations.
text = read('test/hifido.test.ts').replace(
    'assert.equal(hifidoAdapter.discovery.extraPageAllowance, 1);',
    'assert.equal(hifidoAdapter.discovery.policy.extraPageBudget, 1);',
)
write('test/hifido.test.ts', text)
text = read('test/fujiya-avic.test.ts').replace('decision.guardItemCount', 'decision.validateItemCount')
write('test/fujiya-avic.test.ts', text)

# Generator tests reflect minimal adapter + registration transport capability.
text = read('test/create-shop.test.ts')
text = text.replace('  assert.match(adapter, /categoryMapping:/);\n', '  assert.doesNotMatch(adapter, /categoryMapping|transport:/);\n')
text = text.replace('  assert.match(adapter, /coverage: "unknown"/);\n', '  assert.match(adapter, /coverage: "unknown"/);\n  assert.match(adapter, /extraPageBudget: 0/);\n')
text = text.replace('  assert.match(registration, /defaultIntervalMinutes: 60/);\n', '  assert.match(registration, /defaultIntervalMinutes: 60/);\n  assert.match(registration, /transport: \\{ kind: "direct" \\}/);\n')
text = text.replace('    transport: "relay",\n', '')
text = text.replace('  assert.match(adapter, /coverage: "unknown"/);\n  assert.match(adapter, /parse\\(_html: string\\): SellerProduct\\[\\]/);', '  assert.match(adapter, /coverage: "unknown"/);\n  assert.match(adapter, /extraPageBudget: 0/);\n  assert.match(adapter, /parse\\(_html: string\\): SellerProduct\\[\\]/);')
write('test/create-shop.test.ts', text)

# AudioUnion inventory tests now assert registered capability.
text = read('test/audiounion-inventory.test.ts').replace(
    'assert.equal(plugin.inventoryRecheck, audioUnionInventoryRecheck);',
    'assert.equal(plugin.capabilities.inventoryRecheck?.classifyPage, audioUnionInventoryRecheck.classifyPage);',
)
write('test/audiounion-inventory.test.ts', text)
text = read('test/inventory-recheck.test.ts').replace(
    'assert.equal(plain.inventoryRecheck, undefined);',
    'assert.equal(plain.capabilities.inventoryRecheck, undefined);',
)
write('test/inventory-recheck.test.ts', text)

# Catalog normalization tests use explicit catalog configuration instead of concrete adapter shape.
text = read('test/catalog-normalization.test.ts')
text = text.replace(
    'import { fujiyaAvicAdapter } from "../src/crawler/shops/fujiya-avic.js";\n',
    'import { FUJIYA_CATEGORY_POLICY } from "../src/crawler/shops/fujiya-avic.js";\n',
)
text = text.replace('    fujiyaAvicAdapter,\n', '    { categoryPolicy: FUJIYA_CATEGORY_POLICY },\n')
write('test/catalog-normalization.test.ts', text)

# Knowledge-catalog enrichment uses the registered plugin and its catalog config.
text = read('test/knowledge-catalog-enrichment.test.ts')
text = text.replace(
    'import { fujiyaAvicAdapter } from "../src/crawler/shops/fujiya-avic.js";\n',
    'import { getShopPlugin } from "../src/crawler/shops/index.js";\n',
)
text = text.replace(
    'function catalogDb(rows: unknown[], aliases: unknown[] = []) {',
    'const fujiyaAvicPlugin = getShopPlugin("fujiya-avic");\nif (!fujiyaAvicPlugin) throw new Error("fujiya-avic plugin missing");\n\nfunction catalogDb(rows: unknown[], aliases: unknown[] = []) {',
)
text = text.replace('    fujiyaAvicAdapter,\n', '    fujiyaAvicPlugin.capabilities.catalog,\n')
text = text.replace('    adapter: fujiyaAvicAdapter,', '    adapter: fujiyaAvicPlugin,')
text = text.replace(
    'adapter: { ...fujiyaAvicAdapter, extractDetailCategoryEvidence: undefined },',
    'adapter: { ...fujiyaAvicPlugin, capabilities: { ...fujiyaAvicPlugin.capabilities, detailCategoryEvidence: undefined } },',
)
write('test/knowledge-catalog-enrichment.test.ts', text)

# ---------------------------------------------------------------------------
# Documentation: final contract only, no compatibility override guidance.
# ---------------------------------------------------------------------------
text = read('docs/adding-shops.md')
text = text.replace(
    '''  parse(html: string, page?: TPage): SellerProduct[];\n  // optional declared capabilities: transport/category/detail diagnostics/recheck/etc.\n''',
    '''  parse(html: string, page?: TPage): SellerProduct[];\n''',
)
text = text.replace(
    '''interface DiscoveryCapability<TPage extends CrawlPage> {\n  coverage: "complete" | "partial" | "unknown";\n  continueOnEmpty?: boolean;\n  guardItemCount?: boolean;\n  extraPageAllowance?: number;\n  initialTargets(context: DiscoveryContext): Iterable<TPage>;\n  discoverTargets?(html: string, page: TPage): readonly TPage[] | null;\n}\n''',
    '''interface DiscoveryCapability<TPage extends CrawlPage> {\n  coverage: "complete" | "partial" | "unknown";\n  policy: {\n    emptyPage: "stop" | "continue";\n    itemCountValidation: "coverage" | "always";\n    extraPageBudget: number;\n  };\n  initialTargets(context: DiscoveryContext): Iterable<TPage>;\n  discoverTargets?(html: string, page: TPage): readonly TPage[] | null;\n}\n''',
)
text = text.replace(
    '''The platform owns the safety rules: it bounds target count using `maxPages` plus the explicit extra\nallowance, validates every target against the shop's configured HTTPS origin, suppresses duplicate\n''',
    '''The platform owns the safety rules: it bounds target count using `maxPages` plus\n`policy.extraPageBudget`, validates every target against the shop's configured HTTPS origin, suppresses duplicate\n''',
)
text = text.replace(
    '''The legacy `pageUrls`, `discoverPageUrls`, `dynamicPagination`, `partialCoverage`,\n`continueOnEmpty`, `guardItemCount`, and adapter-level `extraPageAllowance` flags are not part of the\ncontract.\n''',
    '''Legacy pagination flags are not accepted. Empty-page behavior, item-count validation, and the\nadditional page budget are expressed only through the typed `discovery.policy` object.\n''',
)
text = text.replace(
    '''Declare deployed values in `wrangler.jsonc`. A shop whose deployed names use a different spelling may\nset `envPrefix` on its definition. Shop-owned discovery inputs such as an entry URL are ordinary env\nvariables read inside that shop module.\n\n`defineShopPlugin` validates the definition and discovery policy at module load. Invalid keys, non-HTTPS\norigins, invalid coverage, negative allowances, unsupported transports, duplicate environment prefixes,\nor duplicate crons fail CI rather than a scheduled crawl. Registered definitions, discovery policies,\nplugins and the registry are frozen.\n''',
    '''Declare deployed values in `wrangler.jsonc`. The prefix is always derived from the shop key; aliases and\ncustom prefix overrides are not supported. For example, `u-audio` always uses `U_AUDIO_*`. Shop-owned\ndiscovery inputs such as an entry URL are ordinary env variables read inside that shop module.\n\n`defineShopPlugin` validates the definition, discovery policy, and declared capabilities at module load.\nInvalid keys, non-HTTPS origins, invalid coverage/policies, negative budgets, unsupported transports,\nor duplicate crons fail CI rather than a scheduled crawl. Registered definitions, discovery policies,\ncapabilities, plugins and the registry are frozen.\n''',
)
text = text.replace(
    '''Seller-category policy may be `authoritative`, `corroborative`, or `ignore`. Detail enrichment via\n`extractDetailCategoryEvidence()` is optional and should return product-specific evidence, not make the\nfinal category decision. Detail requests are bounded by the platform and only unresolved products need\nthem.\n''',
    '''Seller-category policy may be `authoritative`, `corroborative`, or `ignore`. Category mapping/policy is\nregistered under `capabilities.catalog`; optional detail enrichment is registered under\n`capabilities.detailCategoryEvidence`. It returns product-specific evidence, never the final category\ndecision. Detail requests are bounded by the platform and only unresolved products need them.\n''',
)
text = text.replace(
    '## Optional diagnostics and Data Quality capabilities\n',
    '## Optional capabilities\n',
)
text += '''\n\n### Capability composition\n\nThe adapter itself stays universal and minimal. Transport selection, catalog hints, detail evidence,\ninventory recheck, diagnostics, Data Quality thresholds, and activity semantics are attached only at\n`defineShopPlugin(...)` in the composition root. A normal shop must not add a new optional field to\n`ShopAdapter`.\n'''
write('docs/adding-shops.md', text)

print('Phase 3 complete migration source transformation applied.')
