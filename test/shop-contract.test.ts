import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { SHOP_DEFINITIONS, SHOP_ENV_SUFFIXES, shopEnvVarName } from "../src/config.js";
import {
  coverageDecision,
  discoverPages,
  initialPageQueue,
  targetUrl,
} from "../src/crawler/strategies.js";
import { SHOP_PLUGINS } from "../src/crawler/shops/index.js";
import { createShopRegistry, defineShopPlugin } from "../src/crawler/shops/registry.js";
import { isTransportConfigured, relayConfiguration } from "../src/crawler/transport.js";
import type {
  ShopAdapter,
  ShopDefinitionInput,
  ShopPlugin,
  ShopRuntimeCapabilities,
} from "../src/crawler/types.js";

const GENERIC_MODULES = [
  "src/config.ts",
  "src/health.ts",
  "src/index.ts",
  "src/maintenance.ts",
  "src/queue.ts",
  "src/scheduled.ts",
  "src/http/meta.ts",
  "src/http/router.ts",
  "src/crawler/availability.ts",
  "src/crawler/category-enricher.ts",
  "src/crawler/dispatch.ts",
  "src/crawler/inventory-recheck.ts",
  "src/crawler/run.ts",
  "src/crawler/schedule.ts",
  "src/crawler/seller-facts.ts",
  "src/crawler/shops/registry.ts",
  "src/crawler/strategies.ts",
  "src/crawler/transport.ts",
];

const LEGACY_DISCOVERY_FIELDS = [
  "pageUrls",
  "discoverPageUrls",
  "dynamicPagination",
  "partialCoverage",
  "continueOnEmpty",
  "guardItemCount",
  "extraPageAllowance",
] as const;

const LEGACY_CAPABILITY_FIELDS = ["diagnosePage", "qualityThresholds"] as const;

const shopsDir = new URL("../src/crawler/shops/", import.meta.url);
const platformShopModules = new Set(["index.ts", "registry.ts"]);

const wranglerConfig = JSON.parse(
  fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as { vars?: Record<string, string> };

function readSource(path: string): string {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function ownerOfShopFile(file: string): string | undefined {
  return SHOP_PLUGINS.map((plugin) => plugin.key)
    .sort((a, b) => b.length - a.length)
    .find((key) => file === `${key}.ts` || file.startsWith(`${key}-`));
}

function shopOwnedModuleSource(plugin: ShopPlugin): string {
  return fs
    .readdirSync(shopsDir)
    .filter((file) => !platformShopModules.has(file) && ownerOfShopFile(file) === plugin.key)
    .map((file) => fs.readFileSync(new URL(file, shopsDir), "utf8"))
    .join("\n");
}

function directlyReadShopEnvVars(plugin: ShopPlugin, declared: readonly string[]): string[] {
  const source = shopOwnedModuleSource(plugin);
  return declared.filter((name) => source.includes(name));
}

function platformReadableShopEnvVars(plugin: ShopPlugin): string[] {
  return SHOP_ENV_SUFFIXES.filter(
    (suffix) =>
      !suffix.startsWith("INVENTORY_RECHECK_") ||
      plugin.capabilities.inventoryRecheck !== undefined,
  ).map((suffix) => shopEnvVarName(plugin.definition, suffix));
}

function readableShopEnvVars(plugin: ShopPlugin, declared: readonly string[]): Set<string> {
  return new Set([
    ...platformReadableShopEnvVars(plugin),
    ...directlyReadShopEnvVars(plugin, declared),
  ]);
}

function registerStub(
  overrides: Partial<ShopDefinitionInput> = {},
  adapterOverrides: Partial<ShopAdapter> = {},
  capabilities: ShopRuntimeCapabilities = {},
): ShopPlugin {
  const definition: ShopDefinitionInput = {
    key: "example-shop",
    name: "Example Shop",
    baseUrl: "https://example.com",
    defaultIntervalMinutes: 60,
    ...overrides,
  };
  const adapter: ShopAdapter = {
    key: definition.key,
    name: definition.name,
    baseUrl: definition.baseUrl,
    discovery: {
      coverage: "unknown",
      policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },
      *initialTargets() {},
    },
    parse: () => [],
    ...adapterOverrides,
  };
  return defineShopPlugin(adapter, definition, capabilities);
}

test("all shop plugins satisfy the final crawler contract", () => {
  assert.equal(SHOP_PLUGINS.length, 11);
  assert.equal(new Set(SHOP_PLUGINS.map((plugin) => plugin.key)).size, SHOP_PLUGINS.length);

  for (const plugin of SHOP_PLUGINS) {
    assert.ok(plugin.key);
    assert.ok(plugin.name);
    assert.ok(plugin.baseUrl);
    assert.equal(typeof plugin.discovery, "object");
    assert.ok(["complete", "partial", "unknown"].includes(plugin.discovery.coverage));
    assert.equal(typeof plugin.discovery.initialTargets, "function");
    assert.equal(typeof plugin.parse, "function");
    assert.equal(typeof plugin.capabilities, "object");
    assert.equal(plugin.definition.key, plugin.key);
    assert.equal(plugin.definition.name, plugin.name);
    assert.equal(plugin.definition.baseUrl, plugin.baseUrl);
    assert.equal(SHOP_DEFINITIONS[plugin.key], plugin.definition);
    assert.equal(plugin.baseUrl, new URL(plugin.baseUrl).origin);
    assert.match(plugin.definition.envPrefix, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u);
    assert.ok(plugin.definition.defaultIntervalMinutes > 0);
    for (const legacyField of LEGACY_DISCOVERY_FIELDS) {
      assert.equal(legacyField in plugin, false, `${plugin.key} still exposes ${legacyField}`);
    }
    for (const legacyField of LEGACY_CAPABILITY_FIELDS) {
      assert.equal(legacyField in plugin, false, `${plugin.key} still exposes ${legacyField}`);
    }
  }
});

test("registered plugins, definitions and discovery policies are immutable", () => {
  const plugin = SHOP_PLUGINS[0];
  assert.ok(plugin);
  assert.throws(() => {
    (plugin.definition as { name: string }).name = "tampered";
  }, TypeError);
  assert.throws(() => {
    (plugin.discovery as { coverage: string }).coverage = "partial";
  }, TypeError);
  assert.throws(() => {
    (plugin as { key: string }).key = "tampered";
  }, TypeError);
  assert.throws(() => {
    (plugin.capabilities as { diagnostics?: unknown }).diagnostics = {};
  }, TypeError);
  assert.throws(() => (SHOP_PLUGINS as ShopPlugin[]).push(plugin), TypeError);
});

test("registration rejects a definition the platform could not run safely", () => {
  assert.throws(() => registerStub({ key: "Example_Shop" }), /kebab-case/);
  assert.throws(() => registerStub({ name: "  " }), /name is required/);
  assert.throws(() => registerStub({ baseUrl: "https://example.com/used" }), /origin/);
  assert.throws(() => registerStub({ baseUrl: "http://example.com" }), /https/);
  assert.throws(() => registerStub({ baseUrl: "not a url" }), /not a URL/);
  assert.throws(() => registerStub({ defaultIntervalMinutes: 0 }), /defaultIntervalMinutes/);
  assert.throws(() => registerStub({ defaultMaxPages: -1 }), /defaultMaxPages/);
  assert.throws(() => registerStub({ defaultRequestDelayMs: -1 }), /defaultRequestDelayMs/);
  assert.throws(() => registerStub({ scheduleCron: " " }), /scheduleCron/);
  assert.throws(
    () => registerStub({}, {}, { transport: { kind: "carrier-pigeon" as unknown as "direct" } }),
    /not a supported transport/,
  );
  assert.throws(
    () => registerStub({}, { discovery: undefined as unknown as ShopAdapter["discovery"] }),
    /discovery capability is required/,
  );
  assert.throws(
    () =>
      registerStub(
        {},
        {
          discovery: {
            coverage: "everything" as unknown as "complete",
            policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },
            *initialTargets() {},
          },
        },
      ),
    /coverage/,
  );
  assert.throws(
    () =>
      registerStub(
        {},
        {
          discovery: {
            coverage: "unknown",
            policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: -1 },
            *initialTargets() {},
          },
        },
      ),
    /extraPageBudget/,
  );
  assert.throws(() => registerStub({}, { key: "other-shop" }), /adapter key/);
  assert.throws(() => registerStub({}, { baseUrl: "https://other.example" }), /adapter baseUrl/);
});

test("the registry rejects shops that would silently share configuration", () => {
  assert.throws(() => createShopRegistry([registerStub(), registerStub()]), /duplicate shop key/);
  assert.throws(
    () =>
      createShopRegistry([
        registerStub({ key: "one-shop", scheduleCron: "5 * * * *" }),
        registerStub({ key: "two-shop", scheduleCron: "5 * * * *" }),
      ]),
    /share the cron/,
  );
});

test("shop settings are derived from the definition rather than declared per shop", () => {
  assert.equal(registerStub({ key: "example-shop" }).definition.envPrefix, "EXAMPLE_SHOP");

  for (const plugin of SHOP_PLUGINS) {
    for (const suffix of SHOP_ENV_SUFFIXES) {
      assert.equal(
        shopEnvVarName(plugin.definition, suffix),
        `${plugin.definition.envPrefix}_${suffix}`,
      );
    }
  }
});

test("enabled production shops deploy a kill switch under their exact env prefix", () => {
  const declared = new Set(Object.keys(wranglerConfig.vars || {}));
  for (const plugin of SHOP_PLUGINS) {
    if (plugin.definition.defaultEnabled === false) continue;
    const enabledVar = shopEnvVarName(plugin.definition, "ENABLED");
    assert.ok(
      declared.has(enabledVar),
      `${plugin.key} defaults enabled but wrangler.jsonc does not declare ${enabledVar}`,
    );
  }
});

test("shop-owned deployed variables are discovered from shop modules, not a central allowlist", () => {
  const declared = Object.keys(wranglerConfig.vars || {});
  const audioUnion = SHOP_PLUGINS.find((plugin) => plugin.key === "audiounion");
  const hifido = SHOP_PLUGINS.find((plugin) => plugin.key === "hifido");
  assert.ok(audioUnion);
  assert.ok(hifido);
  assert.ok(directlyReadShopEnvVars(audioUnion, declared).includes("AUDIOUNION_ENTRY_URL"));
  assert.ok(directlyReadShopEnvVars(hifido, declared).includes("HIFIDO_RECHECK_MAX_PAGE"));
});

test("capability-scoped settings are readable only for shops that declare the capability", () => {
  const audioUnion = SHOP_PLUGINS.find((plugin) => plugin.key === "audiounion");
  const fujiya = SHOP_PLUGINS.find((plugin) => plugin.key === "fujiya-avic");
  assert.ok(audioUnion);
  assert.ok(fujiya);
  assert.ok(
    platformReadableShopEnvVars(audioUnion).includes("AUDIOUNION_INVENTORY_RECHECK_ENABLED"),
  );
  assert.equal(
    platformReadableShopEnvVars(fujiya).includes("FUJIYA_AVIC_INVENTORY_RECHECK_ENABLED"),
    false,
  );
});

test("every deployed variable under a shop prefix is one that shop can actually read", () => {
  const declared = Object.keys(wranglerConfig.vars || {});

  for (const plugin of SHOP_PLUGINS) {
    const prefix = `${plugin.definition.envPrefix}_`;
    const readable = readableShopEnvVars(plugin, declared);
    const orphans = declared.filter((name) => name.startsWith(prefix) && !readable.has(name));
    assert.deepEqual(
      orphans,
      [],
      `${plugin.key} has unread deployed variables: ${orphans.join(", ")}`,
    );
  }
});

test("generic crawler and orchestration code names no concrete shop", () => {
  const tokens = [
    ...new Set(
      SHOP_PLUGINS.flatMap((plugin) => [
        plugin.key,
        plugin.key.replaceAll("-", "_"),
        plugin.definition.envPrefix,
      ]).map((token) => token.toLowerCase()),
    ),
  ];

  for (const path of GENERIC_MODULES) {
    const source = readSource(path).toLowerCase();
    for (const token of tokens) {
      assert.equal(source.includes(token), false, `${path} names concrete shop ${token}`);
    }
  }
});

test("shop modules do not import generic orchestration or another concrete shop", () => {
  for (const plugin of SHOP_PLUGINS) {
    const source = shopOwnedModuleSource(plugin);
    assert.doesNotMatch(source, /from\s+["']\.\.\/(?:run|dispatch|schedule|transport)\.js["']/u);
    for (const other of SHOP_PLUGINS) {
      if (other.key === plugin.key) continue;
      assert.doesNotMatch(source, new RegExp(`from\\s+["'][^"']*${other.key}[^"']*["']`, "u"));
    }
  }
});

test("shop discovery is bounded by the platform maxPages limit", () => {
  const adapter = registerStub(
    {},
    {
      discovery: {
        coverage: "complete",
        policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 3 },
        *initialTargets() {
          yield "https://example.com/page/1";
          yield "https://example.com/page/2";
          yield "https://example.com/page/3";
        },
        discoverTargets: () => ["https://example.com/page/4"],
      },
    },
  );
  assert.deepEqual(initialPageQueue(adapter, 2), [
    "https://example.com/page/1",
    "https://example.com/page/2",
  ]);
  assert.deepEqual(discoverPages(adapter, "", "https://example.com/page/1"), [
    "https://example.com/page/4",
  ]);
  assert.equal(coverageDecision(adapter, { reachedEnd: true }).deactivateMissing, true);
});

test("partial discovery never deactivates missing listings", () => {
  const adapter = registerStub(
    {},
    {
      discovery: {
        coverage: "partial",
        policy: { emptyPage: "continue", itemCountValidation: "coverage", extraPageBudget: 0 },
        *initialTargets() {
          yield "https://example.com/latest";
        },
      },
    },
  );
  assert.equal(coverageDecision(adapter, { reachedEnd: true }).deactivateMissing, false);
});

test("targetUrl rejects cross-origin and malformed discovery targets", () => {
  const adapter = registerStub();
  assert.equal(targetUrl(adapter, "https://example.com/ok"), "https://example.com/ok");
  assert.throws(() => targetUrl(adapter, "https://evil.example/"), /outside shop origin/);
  assert.throws(
    () => targetUrl(adapter, { url: "http://example.com/insecure" }),
    /outside shop origin/,
  );
  assert.throws(() => targetUrl(adapter, { url: "not-a-url" }), /invalid discovery target/);
});

test("relay transport configuration is mandatory only when declared by the definition", () => {
  const relay = registerStub(
    { transportConfigurationRequired: true },
    {},
    { transport: { kind: "relay" } },
  );
  const direct = registerStub();
  assert.equal(isTransportConfigured(relay, {}), false);
  assert.equal(
    isTransportConfigured(relay, {
      CRAWL_RELAY_URL: "https://relay.example/",
      CRAWL_RELAY_TOKEN: "token",
    }),
    true,
  );
  assert.equal(isTransportConfigured(direct, {}), true);
});

test("transportConfigurationRequired cannot be attached to a non-relay plugin", () => {
  assert.throws(
    () => registerStub({ transportConfigurationRequired: true }),
    /requires relay transport/,
  );
});

test("relayConfiguration rejects incomplete or insecure values", () => {
  assert.throws(() => relayConfiguration({}), /CRAWL_RELAY_URL/);
  assert.throws(
    () =>
      relayConfiguration({ CRAWL_RELAY_URL: "http:\/\/relay.example", CRAWL_RELAY_TOKEN: "token" }),
    /https/,
  );
  assert.throws(
    () => relayConfiguration({ CRAWL_RELAY_URL: "https:\/\/relay.example", CRAWL_RELAY_TOKEN: "" }),
    /CRAWL_RELAY_TOKEN/,
  );
});
