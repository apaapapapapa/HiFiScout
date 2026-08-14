import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { SHOP_DEFINITIONS } from "../src/config.js";
import { coverageDecision, discoverPages, initialPageQueue } from "../src/crawler/strategies.js";
import { SHOP_PLUGINS } from "../src/crawler/shops/index.js";
import { isTransportConfigured, relayConfiguration } from "../src/crawler/transport.js";

/**
 * Modules that drive every shop. Adding a shop must not require editing any of them, so none may
 * mention a shop by key or by its environment-variable prefix.
 */
const GENERIC_MODULES = [
  "src/config.ts",
  "src/health.ts",
  "src/index.ts",
  "src/maintenance.ts",
  "src/crawler/category-enricher.ts",
  "src/crawler/dispatch.ts",
  "src/crawler/inventory-recheck.ts",
  "src/crawler/run.ts",
  "src/crawler/schedule.ts",
  "src/crawler/strategies.ts",
  "src/crawler/transport.ts",
];

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
    assert.ok(plugin.definition.intervalEnv);
    assert.ok(plugin.definition.enabledEnv);
    assert.ok(plugin.definition.requestDelayEnv);
    assert.ok(plugin.definition.defaultIntervalMinutes > 0);
  }
});

test("generic crawler and orchestration code names no concrete shop", () => {
  const tokens = [
    ...new Set(
      SHOP_PLUGINS.flatMap((plugin) => [
        plugin.key,
        plugin.key.replaceAll("-", "_"),
        // `AUDIOUNION_ENABLED` -> `AUDIOUNION`: catches branching on a shop's env prefix too.
        plugin.definition.enabledEnv.replace(/_ENABLED$/u, ""),
      ]).map((token) => token.toLowerCase()),
    ),
  ];

  for (const path of GENERIC_MODULES) {
    const source = fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8").toLowerCase();
    const found = tokens.filter((token) => source.includes(token));
    assert.deepEqual(
      found,
      [],
      `${path} mentions ${found.join(", ")}; move that behavior behind adapter metadata or a hook`,
    );
  }
});

test("shop-specific behavior is opt-in adapter metadata, never a branch in shared code", () => {
  for (const plugin of SHOP_PLUGINS) {
    if (plugin.diagnosePage !== undefined) assert.equal(typeof plugin.diagnosePage, "function");
    if (plugin.inventoryRecheck !== undefined) {
      const policy = plugin.inventoryRecheck;
      assert.equal(typeof policy.isDetailUrl, "function");
      assert.equal(typeof policy.classifyPage, "function");
      for (const env of [
        policy.enabledEnv,
        policy.minListingAgeHoursEnv,
        policy.intervalHoursEnv,
        policy.failureThresholdEnv,
      ]) {
        assert.match(env, /^[A-Z0-9_]+$/u);
      }
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
