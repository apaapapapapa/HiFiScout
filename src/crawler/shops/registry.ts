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
  TransportKind,
} from "../types.js";
import { normalizeCatalogProducts } from "../../catalog/product-normalizer.js";
import { validateSellerProducts } from "../seller-facts.js";
import {
  DEFAULT_PRODUCT_ACTIVITY_POLICY,
  type ProductActivityPolicy,
} from "../../db/product-activity-policy.js";

/** Behaviors a shop opts into at composition time rather than through the adapter contract. */
export interface ShopPluginCapabilities {
  readonly activityPolicy?: Readonly<ProductActivityPolicy>;
}

const SHOP_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const ENV_PREFIX_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

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

const activityPolicies = new WeakMap<ShopPlugin, Readonly<ProductActivityPolicy>>();

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
  assertNonNegativeInt(key, "discovery.extraPageAllowance", discovery.extraPageAllowance);
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

  const envPrefix = input.envPrefix || deriveEnvPrefix(key);
  if (!ENV_PREFIX_PATTERN.test(envPrefix)) {
    invalid(key, `envPrefix must be SCREAMING_SNAKE_CASE: ${envPrefix}`);
  }

  if (!Number.isInteger(input.defaultIntervalMinutes) || input.defaultIntervalMinutes <= 0) {
    invalid(key, "defaultIntervalMinutes must be a positive integer");
  }
  assertNonNegativeInt(key, "defaultRequestDelayMs", input.defaultRequestDelayMs);
  assertPositiveInt(key, "defaultMaxPages", input.defaultMaxPages);
  if (input.scheduleCron !== undefined && !input.scheduleCron.trim()) {
    invalid(key, "scheduleCron must not be empty");
  }
  if (adapter.transport !== undefined && !SUPPORTED_TRANSPORTS[adapter.transport]) {
    invalid(key, `transport ${adapter.transport} is not a supported transport`);
  }

  return Object.freeze({ ...input, envPrefix });
}

/** Compose one concrete adapter into a frozen registered plugin. */
export function defineShopPlugin(
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
  };
  const frozenPlugin = Object.freeze(plugin);
  activityPolicies.set(
    frozenPlugin,
    capabilities.activityPolicy || DEFAULT_PRODUCT_ACTIVITY_POLICY,
  );

  return frozenPlugin;
}

/** Validate cross-plugin invariants once when the composition root is evaluated. */
export function createShopRegistry(plugins: readonly ShopPlugin[]): readonly ShopPlugin[] {
  const seenKeys = new Set<string>();
  const seenPrefixes = new Map<string, string>();
  const seenCrons = new Map<string, string>();

  for (const plugin of plugins) {
    const { key, envPrefix, scheduleCron } = plugin.definition;
    if (seenKeys.has(key)) throw new Error(`duplicate shop key in registry: ${key}`);
    seenKeys.add(key);

    const prefixOwner = seenPrefixes.get(envPrefix);
    if (prefixOwner) {
      throw new Error(`shops ${prefixOwner} and ${key} share the env prefix ${envPrefix}`);
    }
    seenPrefixes.set(envPrefix, key);

    if (!scheduleCron) continue;
    const cronOwner = seenCrons.get(scheduleCron);
    if (cronOwner) {
      throw new Error(`shops ${cronOwner} and ${key} share the cron ${scheduleCron}`);
    }
    seenCrons.set(scheduleCron, key);
  }

  return Object.freeze([...plugins]);
}

/** Resolve optional user-facing activity semantics at the shop composition boundary. */
export function getShopActivityPolicy(plugin: ShopPlugin): Readonly<ProductActivityPolicy> {
  return activityPolicies.get(plugin) || DEFAULT_PRODUCT_ACTIVITY_POLICY;
}
