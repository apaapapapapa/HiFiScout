/**
 * The shop registry: the one place a concrete shop module becomes a runtime plugin.
 *
 * Registration validates platform invariants, derives operational configuration and applies the
 * universal seller-fact validation/catalog-normalization decoration exactly once.
 */

import type {
  CoverageKind,
  CrawlPage,
  ShopAdapter,
  ShopDefinition,
  ShopDefinitionInput,
  ShopPlugin,
  ShopRuntimeCapabilities,
  TransportKind,
} from "../types.js";
import { normalizeCatalogProducts } from "../../catalog/product-normalizer.js";
import { validateSellerProducts } from "../seller-facts.js";
import { DEFAULT_PRODUCT_ACTIVITY_POLICY } from "../../db/product-activity-policy.js";

const SHOP_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const SUPPORTED_TRANSPORTS: Readonly<Record<TransportKind, true>> = {
  direct: true,
  relay: true,
  browser: true,
};

const SUPPORTED_COVERAGE: Readonly<Record<CoverageKind, true>> = {
  complete: true,
  partial: true,
  unknown: true,
};

/** The kebab-case key as its SCREAMING_SNAKE_CASE configuration namespace. */
export function deriveEnvPrefix(key: string): string {
  return key.replaceAll("-", "_").toUpperCase();
}

function invalid(key: string, message: string): never {
  throw new Error(`invalid shop definition ${key || "(missing key)"}: ${message}`);
}

function assertPositiveInt(key: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) invalid(key, `${field} must be a positive integer`);
}

function assertNonNegativeInt(key: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    invalid(key, `${field} must be a non-negative integer`);
  }
}

function assertBaseUrl(key: string, baseUrl: string): void {
  const parsed = parseUrl(key, baseUrl);
  if (parsed.protocol !== "https:") invalid(key, "baseUrl must use https");
  if (baseUrl !== parsed.origin) {
    invalid(key, `baseUrl must be an origin with no path or trailing slash: ${parsed.origin}`);
  }
}

function parseUrl(key: string, baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch {
    invalid(key, `baseUrl is not a URL: ${baseUrl}`);
  }
}

function validateDiscovery(adapter: ShopAdapter): void {
  const { key, discovery } = adapter;
  if (!discovery) invalid(key, "discovery capability is required");
  if (!SUPPORTED_COVERAGE[discovery.coverage]) {
    invalid(key, `discovery coverage ${String(discovery.coverage)} is invalid`);
  }
  if (typeof discovery.initialTargets !== "function") {
    invalid(key, "discovery.initialTargets must be a function");
  }
  if (discovery.discoverTargets !== undefined && typeof discovery.discoverTargets !== "function") {
    invalid(key, "discovery.discoverTargets must be a function when present");
  }
  if (!discovery.policy) invalid(key, "discovery.policy is required");
  if (discovery.policy.emptyPage !== "stop" && discovery.policy.emptyPage !== "continue") {
    invalid(key, `discovery.policy.emptyPage ${String(discovery.policy.emptyPage)} is invalid`);
  }
  if (
    discovery.policy.itemCountValidation !== "coverage" &&
    discovery.policy.itemCountValidation !== "always"
  ) {
    invalid(
      key,
      `discovery.policy.itemCountValidation ${String(discovery.policy.itemCountValidation)} is invalid`,
    );
  }
  assertNonNegativeInt(key, "discovery.policy.extraPageBudget", discovery.policy.extraPageBudget);
}

function validatedDefinition(
  adapter: ShopAdapter,
  input: ShopDefinitionInput,
): Readonly<ShopDefinition> {
  const key = input.key;
  if (!key || !SHOP_KEY_PATTERN.test(key)) invalid(key, "key must be lowercase kebab-case");
  if (adapter?.key !== key) invalid(key, `adapter key is ${adapter?.key || "missing"}`);
  if (!input.name?.trim()) invalid(key, "name is required");
  if (adapter.name !== input.name) invalid(key, "adapter name must match the definition");
  if (adapter.baseUrl !== input.baseUrl) invalid(key, "adapter baseUrl must match the definition");
  assertBaseUrl(key, input.baseUrl);
  validateDiscovery(adapter);

  const envPrefix = deriveEnvPrefix(key);

  if (!Number.isInteger(input.defaultIntervalMinutes) || input.defaultIntervalMinutes <= 0) {
    invalid(key, "defaultIntervalMinutes must be a positive integer");
  }
  assertNonNegativeInt(key, "defaultRequestDelayMs", input.defaultRequestDelayMs);
  assertPositiveInt(key, "defaultMaxPages", input.defaultMaxPages);
  if (input.scheduleCron !== undefined && !input.scheduleCron.trim()) {
    invalid(key, "scheduleCron must not be empty");
  }
  return Object.freeze({ ...input, envPrefix });
}

function validateCapabilities<TPage extends CrawlPage>(
  key: string,
  definition: ShopDefinitionInput,
  capabilities: ShopRuntimeCapabilities<TPage>,
): void {
  const transport = capabilities.transport?.kind;
  if (transport !== undefined && !SUPPORTED_TRANSPORTS[transport]) {
    invalid(key, `transport ${transport} is not a supported transport`);
  }
  if (definition.transportConfigurationRequired === true && transport !== "relay") {
    invalid(key, "transportConfigurationRequired requires relay transport");
  }
}

/** Compose one concrete adapter into a frozen registered plugin. */
export function defineShopPlugin<TPage extends CrawlPage>(
  adapter: ShopAdapter<TPage>,
  definition: ShopDefinitionInput,
  capabilities: ShopRuntimeCapabilities<TPage> = {},
): ShopPlugin<TPage> {
  const validated = validatedDefinition(adapter, definition);
  validateCapabilities(adapter.key, definition, capabilities);
  const parse = adapter.parse;
  const discovery = Object.freeze({
    ...adapter.discovery,
    policy: Object.freeze({ ...adapter.discovery.policy }),
  });
  const runtimeCapabilities: Readonly<ShopRuntimeCapabilities<TPage>> = Object.freeze({
    transport: capabilities.transport ? Object.freeze({ ...capabilities.transport }) : undefined,
    catalog: capabilities.catalog
      ? Object.freeze({
          ...capabilities.catalog,
          categoryMapping: capabilities.catalog.categoryMapping
            ? Object.freeze({ ...capabilities.catalog.categoryMapping })
            : undefined,
          categoryPolicy: capabilities.catalog.categoryPolicy
            ? Object.freeze({ ...capabilities.catalog.categoryPolicy })
            : undefined,
        })
      : undefined,
    detailCategoryEvidence: capabilities.detailCategoryEvidence
      ? Object.freeze({ ...capabilities.detailCategoryEvidence })
      : undefined,
    inventoryRecheck: capabilities.inventoryRecheck
      ? Object.freeze({ ...capabilities.inventoryRecheck })
      : undefined,
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
    activityPolicy: capabilities.activityPolicy
      ? Object.freeze({ ...capabilities.activityPolicy })
      : undefined,
  });
  const plugin: ShopPlugin<TPage> = {
    ...adapter,
    discovery,
    definition: validated,
    capabilities: runtimeCapabilities,
    parse: function normalizedParse(...args: [html: string, page?: TPage]) {
      const sellerProducts = validateSellerProducts(parse.apply(plugin, args), plugin);
      return normalizeCatalogProducts(sellerProducts, runtimeCapabilities.catalog || {}, {
        shopKey: plugin.key,
      });
    },
  };
  return Object.freeze(plugin);
}

/** Validate cross-plugin invariants once when the composition root is evaluated. */
export function createShopRegistry(plugins: readonly ShopPlugin[]): readonly ShopPlugin[] {
  const seenKeys = new Set<string>();

  for (const plugin of plugins) {
    const { key } = plugin.definition;
    if (seenKeys.has(key)) throw new Error(`duplicate shop key in registry: ${key}`);
    seenKeys.add(key);
  }

  // Multiple shops may intentionally share one scheduleCron. The scheduler selects exactly one
  // owner for each trigger event from ScheduledController.scheduledTime, so cron uniqueness is not
  // a registry invariant; shop identity remains unique here.
  return Object.freeze([...plugins]);
}

/** Resolve optional user-facing activity semantics at the shop composition boundary. */
export function getShopActivityPolicy(plugin: ShopPlugin) {
  return plugin.capabilities.activityPolicy || DEFAULT_PRODUCT_ACTIVITY_POLICY;
}
