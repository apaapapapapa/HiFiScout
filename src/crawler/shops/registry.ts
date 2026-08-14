/**
 * The shop registry: the one place a concrete shop module becomes a runtime plugin.
 *
 * Registration is deliberately the narrow part of the platform. It does three things and
 * nothing else:
 *
 * 1. validates the definition, so an invalid shop fails at module load (and therefore in CI)
 *    rather than during a scheduled crawl;
 * 2. derives the shop's environment-variable prefix from its key, so operational configuration
 *    is declared once on the definition instead of being spelled out in a generic type union;
 * 3. applies the universal decoration — central catalog normalization — exactly once, so no
 *    adapter can accidentally skip it or apply it twice.
 *
 * Everything a shop may vary is either definition metadata or a declared capability. There is no
 * per-shop branch here, and there must never be one.
 */

import type {
  CrawlPage,
  ShopAdapter,
  ShopDefinition,
  ShopDefinitionInput,
  ShopPlugin,
  TransportKind,
} from "../types.js";
import { normalizeCatalogProducts } from "../../catalog/product-normalizer.js";
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

/**
 * The transports a shop may select. Declared as a record over the union so adding a transport
 * kind without deciding whether shops may select it is a compile error.
 */
const SUPPORTED_TRANSPORTS: Readonly<Record<TransportKind, true>> = {
  direct: true,
  relay: true,
  browser: true,
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

/**
 * The base URL is the robots.txt origin and the guard every discovered target is measured
 * against, so it must be exactly an https origin — a path or query here would silently widen
 * what the shop is allowed to crawl.
 */
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

  const envPrefix = input.envPrefix || deriveEnvPrefix(key);
  if (!ENV_PREFIX_PATTERN.test(envPrefix)) {
    invalid(key, `envPrefix must be SCREAMING_SNAKE_CASE: ${envPrefix}`);
  }

  if (!Number.isInteger(input.defaultIntervalMinutes) || input.defaultIntervalMinutes <= 0) {
    invalid(key, "defaultIntervalMinutes must be a positive integer");
  }
  assertNonNegativeInt(key, "defaultRequestDelayMs", input.defaultRequestDelayMs);
  assertPositiveInt(key, "defaultMaxPages", input.defaultMaxPages);
  assertNonNegativeInt(key, "extraPageAllowance", adapter.extraPageAllowance);
  if (input.scheduleCron !== undefined && !input.scheduleCron.trim()) {
    invalid(key, "scheduleCron must not be empty");
  }
  if (adapter.transport !== undefined && !SUPPORTED_TRANSPORTS[adapter.transport]) {
    invalid(key, `transport ${adapter.transport} is not a supported transport`);
  }

  return Object.freeze({ ...input, envPrefix });
}

/**
 * Composes one concrete adapter into a registered plugin.
 *
 * `parse` is supplied in the literal (rather than assigned afterwards) so the plugin can be
 * typed without an assertion. Runtime is unchanged: the spread already places `parse` at the
 * adapter's key position, the explicit entry only replaces its value, and `plugin` is only
 * dereferenced when the wrapper is later called.
 */
export function defineShopPlugin(
  adapter: ShopAdapter,
  definition: ShopDefinitionInput,
  capabilities: ShopPluginCapabilities = {},
): ShopPlugin {
  const validated = validatedDefinition(adapter, definition);
  const parse = adapter.parse;
  const plugin: ShopPlugin = {
    ...adapter,
    definition: validated,
    parse: function normalizedParse(...args: [html: string, page?: CrawlPage]) {
      return normalizeCatalogProducts(parse.apply(plugin, args), plugin);
    },
  };
  const frozenPlugin = Object.freeze(plugin);
  activityPolicies.set(
    frozenPlugin,
    capabilities.activityPolicy || DEFAULT_PRODUCT_ACTIVITY_POLICY,
  );

  return frozenPlugin;
}

/**
 * Cross-plugin invariants, checked once when the registry is composed.
 *
 * A duplicate env prefix would make two shops share a kill switch and an interval; a duplicate
 * cron would dispatch one shop twice per window and skip the other. Both are silent in
 * production and obvious here.
 */
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
