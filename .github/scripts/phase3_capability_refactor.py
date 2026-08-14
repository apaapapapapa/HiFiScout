from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} matches, found {actual} for {old[:80]!r}")
    p.write_text(text.replace(old, new, count))


# crawler/types.ts: optional seller-specific behavior is no longer a flat adapter field.
replace(
    "src/crawler/types.ts",
    """// ---------------------------------------------------------------------------
// Shop adapter contract
// ---------------------------------------------------------------------------

/**
 * Universal shop contract: identity, discovery and seller-fact parsing. Transport/category
 * policy and lifecycle hooks are explicit optional capabilities layered on top.
 */
export interface ShopAdapter<TPage extends CrawlPage = CrawlPage> {""",
    """// ---------------------------------------------------------------------------
// Optional runtime capabilities
// ---------------------------------------------------------------------------

/** Seller-specific diagnostic metadata. Generic orchestration treats the result as opaque. */
export interface PageDiagnosticsCapability<TPage extends CrawlPage = CrawlPage> {
  diagnosePage(html: string, page?: TPage): unknown;
}

/** Per-shop Data Quality configuration. Metric calculation remains platform-owned. */
export interface DataQualityCapability {
  readonly thresholds?: Readonly<Record<string, Partial<QualityThreshold>>>;
}

/** Capabilities exposed only after a shop is registered by the platform composition root. */
export interface ShopRuntimeCapabilities<TPage extends CrawlPage = CrawlPage> {
  readonly diagnostics?: Readonly<PageDiagnosticsCapability<TPage>>;
  readonly dataQuality?: Readonly<DataQualityCapability>;
}

// ---------------------------------------------------------------------------
// Shop adapter contract
// ---------------------------------------------------------------------------

/**
 * Universal seller-facing contract: identity, discovery and seller-fact parsing. Optional
 * platform behavior is attached at registration through `ShopRuntimeCapabilities`.
 */
export interface ShopAdapter<TPage extends CrawlPage = CrawlPage> {""",
)
replace(
    "src/crawler/types.ts",
    """
  /** Opaque per-page diagnostics retained by generic orchestration. */
  diagnosePage?(html: string, page?: TPage): unknown;

  /** Opt-in single-listing inventory recheck, run after this shop's crawl succeeds. */
  readonly inventoryRecheck?: InventoryRecheckPolicy;

  isConfigured?(env: CrawlerEnv): boolean;

  /** Per-shop data-quality threshold overrides; keys are `DEFAULT_QUALITY_THRESHOLDS` keys. */
  readonly qualityThresholds?: Readonly<Record<string, Partial<QualityThreshold>>>;

  /** Present only after `defineShopPlugin`; see `ShopPlugin`. */""",
    """
  /** Opt-in single-listing inventory recheck, run after this shop's crawl succeeds. */
  readonly inventoryRecheck?: InventoryRecheckPolicy;

  isConfigured?(env: CrawlerEnv): boolean;

  /** Present only after `defineShopPlugin`; see `ShopPlugin`. */""",
)
replace(
    "src/crawler/types.ts",
    """> {
  readonly definition: Readonly<ShopDefinition>;
  parse(html: string, page?: TPage): NormalizedCatalogProduct[];
}""",
    """> {
  readonly definition: Readonly<ShopDefinition>;
  readonly capabilities: Readonly<ShopRuntimeCapabilities<TPage>>;
  parse(html: string, page?: TPage): NormalizedCatalogProduct[];
}""",
)

# registry.ts: registration is the only place optional runtime capabilities enter a plugin.
replace(
    "src/crawler/shops/registry.ts",
    """  ShopPlugin,
  TransportKind,
} from \"../types.js\";""",
    """  ShopPlugin,
  ShopRuntimeCapabilities,
  TransportKind,
} from \"../types.js\";""",
)
replace(
    "src/crawler/shops/registry.ts",
    """export interface ShopPluginCapabilities {
  readonly activityPolicy?: Readonly<ProductActivityPolicy>;
}""",
    """export interface ShopPluginCapabilities<TPage extends CrawlPage = CrawlPage>
  extends ShopRuntimeCapabilities<TPage> {
  readonly activityPolicy?: Readonly<ProductActivityPolicy>;
}""",
)
replace(
    "src/crawler/shops/registry.ts",
    """export function defineShopPlugin(
  adapter: ShopAdapter,
  definition: ShopDefinitionInput,
  capabilities: ShopPluginCapabilities = {},
): ShopPlugin {
  const validated = validatedDefinition(adapter, definition);
  const parse = adapter.parse;
  const discovery = Object.freeze({ ...adapter.discovery });
  const plugin: ShopPlugin = {
    ...adapter,
    discovery,
    definition: validated,
    parse: function normalizedParse(...args: [html: string, page?: CrawlPage]) {
      const sellerProducts = validateSellerProducts(parse.apply(plugin, args), plugin);
      return normalizeCatalogProducts(sellerProducts, plugin);
    },
  };""",
    """export function defineShopPlugin<TPage extends CrawlPage>(
  adapter: ShopAdapter<TPage>,
  definition: ShopDefinitionInput,
  capabilities: ShopPluginCapabilities<TPage> = {},
): ShopPlugin<TPage> {
  const validated = validatedDefinition(adapter, definition);
  const parse = adapter.parse;
  const discovery = Object.freeze({ ...adapter.discovery });
  const runtimeCapabilities: Readonly<ShopRuntimeCapabilities<TPage>> = Object.freeze({
    diagnostics: capabilities.diagnostics
      ? Object.freeze({ ...capabilities.diagnostics })
      : undefined,
    dataQuality: capabilities.dataQuality
      ? Object.freeze({
          ...capabilities.dataQuality,
          thresholds: capabilities.dataQuality.thresholds
            ? Object.freeze({ ...capabilities.dataQuality.thresholds })
            : undefined,
        })
      : undefined,
  });
  const plugin: ShopPlugin<TPage> = {
    ...adapter,
    discovery,
    definition: validated,
    capabilities: runtimeCapabilities,
    parse: function normalizedParse(...args: [html: string, page?: TPage]) {
      const sellerProducts = validateSellerProducts(parse.apply(plugin, args), plugin);
      return normalizeCatalogProducts(sellerProducts, plugin);
    },
  };""",
)

# AudioUnion owns the diagnostic implementation; the composition root declares the capability.
replace(
    "src/crawler/shops/audiounion.ts",
    'import { diagnoseAudioUnionHtml } from "./audiounion-diagnostics.js";\n',
    "",
)
replace(
    "src/crawler/shops/audiounion.ts",
    """  diagnosePage(html) {
    return diagnoseAudioUnionHtml(html);
  },
""",
    "",
)
replace(
    "src/crawler/shops/index.ts",
    'import { audioUnionAdapter } from "./audiounion.js";\n',
    'import { audioUnionAdapter } from "./audiounion.js";\nimport { diagnoseAudioUnionHtml } from "./audiounion-diagnostics.js";\n',
)
replace(
    "src/crawler/shops/index.ts",
    """  defineShopPlugin(audioUnionAdapter, {
    key: "audiounion",
    name: "Audio Union",
    baseUrl: "https://www.audiounion.jp",
    defaultIntervalMinutes: 30,
    defaultRequestDelayMs: 10_000,
    scheduleCron: "1 * * * *",
    transportConfigurationRequired: true,
  }),""",
    """  defineShopPlugin(
    audioUnionAdapter,
    {
      key: "audiounion",
      name: "Audio Union",
      baseUrl: "https://www.audiounion.jp",
      defaultIntervalMinutes: 30,
      defaultRequestDelayMs: 10_000,
      scheduleCron: "1 * * * *",
      transportConfigurationRequired: true,
    },
    { diagnostics: { diagnosePage: diagnoseAudioUnionHtml } },
  ),""",
)

# run.ts consumes only registered capabilities; diagnostics stay opaque.
replace(
    "src/crawler/run.ts",
    """      thresholdOverrides: adapter.qualityThresholds
        ? { [adapter.key]: adapter.qualityThresholds }
        : {},""",
    """      thresholdOverrides: adapter.capabilities.dataQuality?.thresholds || {},""",
)
replace(
    "src/crawler/run.ts",
    """  /** Last non-null value from the adapter's optional `diagnosePage` hook; shape is opaque here. */
  let pageDiagnostic: unknown = null;""",
    """  /** Last non-null seller diagnostic; generic orchestration never interprets its shape. */
  let pageDiagnostic: unknown = null;""",
)
replace(
    "src/crawler/run.ts",
    """      const diagnostic = adapter.diagnosePage?.(html, page);
      if (diagnostic != null) pageDiagnostic = diagnostic;""",
    """      const diagnostic = adapter.capabilities.diagnostics?.diagnosePage(html, page);
      if (diagnostic != null) pageDiagnostic = diagnostic;""",
)

# Data Quality receives only the current shop's direct configuration, never a shop-key map.
replace(
    "src/data-quality/quality-thresholds.ts",
    """/**
 * Shape of a merged per-shop threshold set. `Object.fromEntries` cannot preserve the key
 * union, so the resolved map is string-keyed; it still holds exactly the eight default keys.
 */
export type ResolvedQualityThresholds = Readonly<Record<string, QualityThreshold>>;

/**
 * Per-shop overrides, keyed by shop key then by threshold key. Adapters supply a
 * `Record<string, Partial<QualityThreshold>>`, so the inner keys stay `string`.
 */
export type QualityThresholdOverrides = Readonly<
  Record<string, Readonly<Record<string, Partial<QualityThreshold>>>>
>;""",
    """/** A complete threshold set after applying optional per-shop configuration. */
export type ResolvedQualityThresholds = QualityThresholds;

/** Direct overrides for one shop. Shop selection belongs to the plugin capability boundary. */
export type QualityThresholdOverrides = Readonly<
  Partial<Record<QualityThresholdKey, Readonly<Partial<QualityThreshold>>>>
>;""",
)
replace(
    "src/data-quality/quality-thresholds.ts",
    """export function qualityThresholdsForShop(
  shopKey: string,
  overrides: QualityThresholdOverrides = {},
): ResolvedQualityThresholds {
  const shopOverrides = overrides?.[shopKey] || {};
  return Object.fromEntries(
    Object.entries(DEFAULT_QUALITY_THRESHOLDS).map(([key, value]): [string, QualityThreshold] => [
      key,
      { ...value, ...shopOverrides[key] },
    ]),
  );
}""",
    """export function resolveQualityThresholds(
  overrides: QualityThresholdOverrides = {},
): ResolvedQualityThresholds {
  return Object.freeze({
    manufacturerUnknownRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.manufacturerUnknownRate,
      ...overrides.manufacturerUnknownRate,
    },
    categoryUnclassifiedRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.categoryUnclassifiedRate,
      ...overrides.categoryUnclassifiedRate,
    },
    identityUnresolvedRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.identityUnresolvedRate,
      ...overrides.identityUnresolvedRate,
    },
    inventoryUnknownRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.inventoryUnknownRate,
      ...overrides.inventoryUnknownRate,
    },
    modelMissingRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.modelMissingRate,
      ...overrides.modelMissingRate,
    },
    parserFailureRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.parserFailureRate,
      ...overrides.parserFailureRate,
    },
    itemCountDropRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.itemCountDropRate,
      ...overrides.itemCountDropRate,
    },
    evidenceCoverageRate: {
      ...DEFAULT_QUALITY_THRESHOLDS.evidenceCoverageRate,
      ...overrides.evidenceCoverageRate,
    },
  });
}""",
)
replace(
    "src/data-quality/quality-evaluator.ts",
    'import { qualityThresholdsForShop } from "./quality-thresholds.js";',
    'import { resolveQualityThresholds } from "./quality-thresholds.js";',
)
replace(
    "src/data-quality/quality-evaluator.ts",
    "  const thresholds = qualityThresholdsForShop(shopKey, thresholdOverrides);",
    "  const thresholds = resolveQualityThresholds(thresholdOverrides);",
)

# Evaluator contract test proves direct, shop-agnostic configuration.
replace(
    "test/data-quality-evaluator.test.ts",
    """  const result = evaluateQuality(healthyInput({ manufacturerMissingCount: 3 }), {
    thresholdOverrides: {
      "test-shop": {
        manufacturerUnknownRate: { warning: 0.04, critical: 0.08 },
      },
    },
  });""",
    """  const result = evaluateQuality(healthyInput({ manufacturerMissingCount: 3 }), {
    thresholdOverrides: {
      manufacturerUnknownRate: { warning: 0.04, critical: 0.08 },
    },
  });""",
)

# Contract tests prohibit regression to flat shop hooks and exercise the capability boundary.
replace(
    "test/shop-contract.test.ts",
    'import { createShopRegistry, defineShopPlugin } from "../src/crawler/shops/registry.js";',
    """import {
  createShopRegistry,
  defineShopPlugin,
  type ShopPluginCapabilities,
} from "../src/crawler/shops/registry.js";""",
)
replace(
    "test/shop-contract.test.ts",
    """const LEGACY_DISCOVERY_FIELDS = [
  "pageUrls",
  "discoverPageUrls",
  "dynamicPagination",
  "partialCoverage",
  "continueOnEmpty",
  "guardItemCount",
  "extraPageAllowance",
] as const;""",
    """const LEGACY_DISCOVERY_FIELDS = [
  "pageUrls",
  "discoverPageUrls",
  "dynamicPagination",
  "partialCoverage",
  "continueOnEmpty",
  "guardItemCount",
  "extraPageAllowance",
] as const;

const LEGACY_CAPABILITY_FIELDS = ["diagnosePage", "qualityThresholds"] as const;""",
)
replace(
    "test/shop-contract.test.ts",
    """function registerStub(
  overrides: Partial<ShopDefinitionInput> = {},
  adapterOverrides: Partial<ShopAdapter> = {},
): ShopPlugin {""",
    """function registerStub(
  overrides: Partial<ShopDefinitionInput> = {},
  adapterOverrides: Partial<ShopAdapter> = {},
  capabilities: ShopPluginCapabilities = {},
): ShopPlugin {""",
)
replace(
    "test/shop-contract.test.ts",
    "  return defineShopPlugin(adapter, definition);\n}",
    "  return defineShopPlugin(adapter, definition, capabilities);\n}",
)
replace(
    "test/shop-contract.test.ts",
    """    assert.equal(typeof plugin.parse, "function");
    assert.equal(plugin.definition.key, plugin.key);""",
    """    assert.equal(typeof plugin.parse, "function");
    assert.equal(typeof plugin.capabilities, "object");
    assert.equal(plugin.definition.key, plugin.key);""",
)
replace(
    "test/shop-contract.test.ts",
    """    for (const legacyField of LEGACY_DISCOVERY_FIELDS) {
      assert.equal(legacyField in plugin, false, `${plugin.key} still exposes ${legacyField}`);
    }
  }
});""",
    """    for (const legacyField of LEGACY_DISCOVERY_FIELDS) {
      assert.equal(legacyField in plugin, false, `${plugin.key} still exposes ${legacyField}`);
    }
    for (const legacyField of LEGACY_CAPABILITY_FIELDS) {
      assert.equal(legacyField in plugin, false, `${plugin.key} still exposes ${legacyField}`);
    }
  }
});""",
)
replace(
    "test/shop-contract.test.ts",
    """  assert.throws(() => {
    (plugin as { key: string }).key = "tampered";
  }, TypeError);
  assert.throws(() => (SHOP_PLUGINS as ShopPlugin[]).push(plugin), TypeError);""",
    """  assert.throws(() => {
    (plugin as { key: string }).key = "tampered";
  }, TypeError);
  assert.throws(() => {
    (plugin.capabilities as { diagnostics?: unknown }).diagnostics = {};
  }, TypeError);
  assert.throws(() => (SHOP_PLUGINS as ShopPlugin[]).push(plugin), TypeError);""",
)
replace(
    "test/shop-contract.test.ts",
    """test("shop-specific behavior is opt-in capability metadata", () => {
  for (const plugin of SHOP_PLUGINS) {
    if (plugin.diagnosePage !== undefined) assert.equal(typeof plugin.diagnosePage, "function");
    if (plugin.inventoryRecheck !== undefined) {""",
    """test("shop-specific behavior is opt-in capability metadata", () => {
  for (const plugin of SHOP_PLUGINS) {
    if (plugin.capabilities.diagnostics !== undefined) {
      assert.equal(typeof plugin.capabilities.diagnostics.diagnosePage, "function");
    }
    if (plugin.capabilities.dataQuality?.thresholds !== undefined) {
      assert.equal(typeof plugin.capabilities.dataQuality.thresholds, "object");
    }
    if (plugin.inventoryRecheck !== undefined) {""",
)
marker = 'test("relay transport requires the shared crawler configuration", () => {'
insertion = """test("diagnostics and Data Quality overrides are registered behind capabilities", () => {
  const plugin = registerStub({}, {}, {
    diagnostics: { diagnosePage: () => ({ kind: "fixture" }) },
    dataQuality: {
      thresholds: {
        manufacturerUnknownRate: { warning: 0.04, critical: 0.08 },
      },
    },
  });

  assert.equal("diagnosePage" in plugin, false);
  assert.equal("qualityThresholds" in plugin, false);
  assert.deepEqual(plugin.capabilities.diagnostics?.diagnosePage("<html></html>"), {
    kind: "fixture",
  });
  assert.equal(
    plugin.capabilities.dataQuality?.thresholds?.manufacturerUnknownRate?.warning,
    0.04,
  );
});

"""
replace("test/shop-contract.test.ts", marker, insertion + marker)

# Document the final onboarding boundary without making optional capabilities mandatory.
docs = Path("docs/adding-shops.md")
text = docs.read_text()
if "## Optional diagnostics and Data Quality capabilities" not in text:
    text += """

## Optional diagnostics and Data Quality capabilities

A normal shop does not need either capability. Seller-specific diagnostics and threshold tuning are
registered explicitly at the composition boundary; do not add flat hooks to `ShopAdapter` and do
not branch on a shop key inside the generic crawler or Data Quality evaluator.

```ts
defineShopPlugin(adapter, definition, {
  diagnostics: {
    diagnosePage: (html, page) => diagnoseSellerMarkup(html, page),
  },
  dataQuality: {
    thresholds: {
      inventoryUnknownRate: { warning: 0.1, critical: 0.25 },
    },
  },
});
```

`diagnostics.diagnosePage` may return seller-specific explanatory metadata, but the generic crawl
lifecycle treats that value as opaque. `dataQuality.thresholds` may tune the shared metrics only;
shops must not replace or duplicate the common evaluator. If a new quality concept should apply to
all shops, add it to the platform instead.
"""
    docs.write_text(text)
