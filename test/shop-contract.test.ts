import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { SHOP_DEFINITIONS, SHOP_ENV_SUFFIXES, shopEnvVarName } from "../src/config.js";
import { coverageDecision, discoverPages, initialPageQueue } from "../src/crawler/strategies.js";
import { SHOP_PLUGINS } from "../src/crawler/shops/index.js";
import { createShopRegistry, defineShopPlugin } from "../src/crawler/shops/registry.js";
import { isTransportConfigured, relayConfiguration } from "../src/crawler/transport.js";
import type { ShopAdapter, ShopDefinitionInput, ShopPlugin } from "../src/crawler/types.js";

/**
 * Modules that drive every shop. Adding a shop must not require editing any of them, so none may
 * mention a shop by key or by its environment-variable prefix. `shops/index.ts` is the one
 * deliberate exception — it is the composition list — which is why the registration machinery
 * lives in `shops/registry.ts` and is checked here with the rest.
 */
const GENERIC_MODULES = [
  "src/config.ts",
  "src/health.ts",
  "src/index.ts",
  "src/maintenance.ts",
  "src/queue.ts",
  "src/scheduled.ts",
  "src/http/meta.ts",
  "src/http/router.ts",
  "src/crawler/category-enricher.ts",
  "src/crawler/dispatch.ts",
  "src/crawler/inventory-recheck.ts",
  "src/crawler/run.ts",
  "src/crawler/schedule.ts",
  "src/crawler/shops/registry.ts",
  "src/crawler/strategies.ts",
  "src/crawler/transport.ts",
];

/**
 * Deployed variables a shop reads itself rather than through the platform settings vocabulary.
 * They are discovery inputs, not operational policy; anything else under a shop's prefix is a
 * name the crawler will never read.
 */
const SHOP_OWNED_DEPLOYED_VARS = new Set(["AUDIOUNION_ENTRY_URL", "HIFIDO_RECHECK_MAX_PAGE"]);

const wranglerConfig = JSON.parse(
  fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as { vars?: Record<string, string> };

function readSource(path: string): string {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * A minimal adapter/definition pair. Overrides land on both halves so a test only varies the
 * field it is about, and `defineShopPlugin` still sees a self-consistent shop.
 */
function registerStub(
  overrides: Partial<ShopDefinitionInput> = {},
  adapterOverrides: Partial<ShopAdapter> = {},
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
    *pageUrls() {},
    parse: () => [],
    ...adapterOverrides,
  };
  return defineShopPlugin(adapter, definition);
}

test("all shop plugins satisfy the crawler contract", () => {
  assert.ok(SHOP_PLUGINS.length >= 5);
  assert.equal(new Set(SHOP_PLUGINS.map((plugin) => plugin.key)).size, SHOP_PLUGINS.length);

  for (const plugin of SHOP_PLUGINS) {
    assert.ok(plugin.key);
    assert.ok(plugin.name);
    assert.ok(plugin.baseUrl);
    assert.equal(typeof plugin.pageUrls, "function");
    assert.equal(typeof plugin.parse, "function");
    assert.equal(plugin.definition.key, plugin.key);
    assert.equal(plugin.definition.name, plugin.name);
    assert.equal(plugin.definition.baseUrl, plugin.baseUrl);
    assert.equal(SHOP_DEFINITIONS[plugin.key], plugin.definition);
    assert.equal(plugin.baseUrl, new URL(plugin.baseUrl).origin);
    assert.match(plugin.definition.envPrefix, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u);
    assert.ok(plugin.definition.defaultIntervalMinutes > 0);
  }
});

test("a registered plugin and its definition cannot be mutated afterwards", () => {
  const plugin = SHOP_PLUGINS[0];
  assert.ok(plugin);
  assert.throws(() => {
    (plugin.definition as { name: string }).name = "tampered";
  }, TypeError);
  assert.throws(() => {
    (plugin as { key: string }).key = "tampered";
  }, TypeError);
  // The registry itself is frozen too, so no caller can append an unvalidated shop at runtime.
  assert.throws(() => (SHOP_PLUGINS as ShopPlugin[]).push(plugin), TypeError);
});

test("registration rejects a definition the platform could not run safely", () => {
  assert.throws(() => registerStub({ key: "Example_Shop" }), /kebab-case/);
  assert.throws(() => registerStub({ name: "  " }), /name is required/);
  assert.throws(() => registerStub({ baseUrl: "https://example.com/used" }), /origin/);
  assert.throws(() => registerStub({ baseUrl: "http://example.com" }), /https/);
  assert.throws(() => registerStub({ baseUrl: "not a url" }), /not a URL/);
  assert.throws(() => registerStub({ envPrefix: "example shop" }), /SCREAMING_SNAKE_CASE/);
  assert.throws(() => registerStub({ defaultIntervalMinutes: 0 }), /defaultIntervalMinutes/);
  assert.throws(() => registerStub({ defaultMaxPages: -1 }), /defaultMaxPages/);
  assert.throws(() => registerStub({ defaultRequestDelayMs: -1 }), /defaultRequestDelayMs/);
  assert.throws(() => registerStub({ scheduleCron: " " }), /scheduleCron/);
  assert.throws(
    () => registerStub({}, { transport: "carrier-pigeon" as unknown as "direct" }),
    /not a supported transport/,
  );
  // An adapter whose identity drifts from its registration would be configured as another shop.
  assert.throws(() => registerStub({}, { key: "other-shop" }), /adapter key/);
  assert.throws(() => registerStub({}, { baseUrl: "https://other.example" }), /adapter baseUrl/);
});

test("the registry rejects shops that would silently share configuration", () => {
  assert.throws(() => createShopRegistry([registerStub(), registerStub()]), /duplicate shop key/);
  assert.throws(
    () =>
      createShopRegistry([
        registerStub({ key: "one-shop", envPrefix: "SHARED" }),
        registerStub({ key: "two-shop", envPrefix: "SHARED" }),
      ]),
    /share the env prefix/,
  );
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
  // `fujiya-avic` -> `FUJIYA_AVIC`; a shop only states a prefix when its deployed names differ.
  assert.equal(registerStub({ key: "example-shop" }).definition.envPrefix, "EXAMPLE_SHOP");
  assert.equal(registerStub({ envPrefix: "LEGACY" }).definition.envPrefix, "LEGACY");

  for (const plugin of SHOP_PLUGINS) {
    for (const suffix of SHOP_ENV_SUFFIXES) {
      assert.equal(
        shopEnvVarName(plugin.definition, suffix),
        `${plugin.definition.envPrefix}_${suffix}`,
      );
    }
  }
});

test("every deployed variable under a shop prefix is one the crawler reads", () => {
  const declared = Object.keys(wranglerConfig.vars || {});
  const readable = new Set(
    SHOP_PLUGINS.flatMap((plugin) =>
      SHOP_ENV_SUFFIXES.map((suffix) => shopEnvVarName(plugin.definition, suffix)),
    ),
  );

  for (const plugin of SHOP_PLUGINS) {
    const prefix = `${plugin.definition.envPrefix}_`;
    const orphans = declared.filter(
      (name) =>
        name.startsWith(prefix) && !readable.has(name) && !SHOP_OWNED_DEPLOYED_VARS.has(name),
    );
    assert.deepEqual(
      orphans,
      [],
      `wrangler.jsonc declares ${orphans.join(", ")} for ${plugin.key}, which nothing reads`,
    );
  }
});

test("generic crawler and orchestration code names no concrete shop", () => {
  const tokens = [
    ...new Set(
      SHOP_PLUGINS.flatMap((plugin) => [
        plugin.key,
        plugin.key.replaceAll("-", "_"),
        // The env prefix catches branching on a shop's configuration namespace too.
        plugin.definition.envPrefix,
      ]).map((token) => token.toLowerCase()),
    ),
  ];

  for (const path of GENERIC_MODULES) {
    const source = readSource(path).toLowerCase();
    const found = tokens.filter((token) => source.includes(token));
    assert.deepEqual(
      found,
      [],
      `${path} mentions ${found.join(", ")}; move that behavior behind adapter metadata or a hook`,
    );
  }
});

test("a shop module never imports another shop's module", () => {
  const shopsDir = new URL("../src/crawler/shops/", import.meta.url);
  const platformModules = new Set(["index.ts", "registry.ts"]);
  const keys = SHOP_PLUGINS.map((plugin) => plugin.key);
  // Longest match first: `audiounion-inventory` belongs to `audiounion`, not to a shorter key.
  const ownerOf = (file: string): string | undefined =>
    [...keys]
      .sort((a, b) => b.length - a.length)
      .find((key) => file === `${key}.ts` || file.startsWith(`${key}-`));

  const files = fs.readdirSync(shopsDir).filter((file) => !platformModules.has(file));
  assert.ok(files.length >= SHOP_PLUGINS.length);

  for (const file of files) {
    const owner = ownerOf(file);
    assert.ok(owner, `${file} does not belong to any registered shop`);

    const source = fs.readFileSync(new URL(file, shopsDir), "utf8");
    const siblings = [...source.matchAll(/from\s+"\.\/([^"]+)\.js"/gu)].map((match) => match[1]);
    for (const sibling of siblings) {
      assert.equal(
        ownerOf(`${sibling}.ts`),
        owner,
        `${file} imports ${sibling}, which belongs to another shop`,
      );
    }
  }
});

test("shop-specific behavior is opt-in adapter metadata, never a branch in shared code", () => {
  for (const plugin of SHOP_PLUGINS) {
    if (plugin.diagnosePage !== undefined) assert.equal(typeof plugin.diagnosePage, "function");
    if (plugin.inventoryRecheck !== undefined) {
      const policy = plugin.inventoryRecheck;
      assert.equal(typeof policy.isDetailUrl, "function");
      assert.equal(typeof policy.classifyPage, "function");
      // A shop cannot be rechecked through a transport that cannot return an upstream status.
      assert.equal(plugin.transport, "relay");
    }
    if (plugin.definition.transportConfigurationRequired) {
      assert.ok(plugin.transport, `${plugin.key} grades configuration but declares no transport`);
    }
  }
});

test("relay transport requires the shared crawler configuration", () => {
  const plugin = SHOP_PLUGINS.find((candidate) => candidate.key === "audiounion");
  assert.ok(plugin);

  assert.deepEqual(
    relayConfiguration({
      CRAWL_RELAY_URL: "https://shared.example/",
      CRAWL_RELAY_TOKEN: "shared-token",
    }),
    { relayUrl: "https://shared.example/", relayToken: "shared-token" },
  );

  assert.equal(
    isTransportConfigured(
      {
        CRAWL_RELAY_URL: "https://shared.example/",
        CRAWL_RELAY_TOKEN: "shared-token",
      },
      plugin,
    ),
    true,
  );
  assert.equal(isTransportConfigured({}, plugin), false);
});

test("pagination and coverage strategies preserve existing adapter semantics", () => {
  const fixed = {
    *pageUrls(maxPages = 0) {
      for (let page = 1; page <= maxPages; page += 1) yield `/${page}`;
    },
  };
  assert.deepEqual(initialPageQueue(fixed, 2, {}, {}), ["/1", "/2"]);
  assert.deepEqual(discoverPages({ ...fixed, dynamicPagination: false }, "<html>", "/1"), []);

  const complete = coverageDecision(
    { dynamicPagination: true },
    {
      reachedEnd: false,
      coverageIncomplete: false,
      queueEmpty: true,
    },
  );
  assert.deepEqual(complete, { deactivateMissing: true, guardItemCount: true });

  const partial = coverageDecision(
    { partialCoverage: true, guardItemCount: true },
    {
      reachedEnd: true,
      coverageIncomplete: false,
      queueEmpty: true,
    },
  );
  assert.deepEqual(partial, { deactivateMissing: false, guardItemCount: true });
});
