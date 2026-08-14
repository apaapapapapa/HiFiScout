import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPANDED_OFFICIAL_SOURCES,
  expandedKnowledgeSourceEnv,
  knowledgeSourceDefinitions,
  resolveKnowledgeSourceDefinitions,
} from "../src/catalog/knowledge-verification/source-registry.js";

const EXPANDED_MANUFACTURERS = [
  "sony",
  "mcintosh",
  "mark-levinson",
  "kef",
  "jbl",
  "dali",
  "audio-technica",
  "ortofon",
  "stax",
  "fostex",
  "focal",
];

test("source registry can disable a built-in manufacturer and add an external adapter", () => {
  const definitions = knowledgeSourceDefinitions({
    KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON: JSON.stringify([
      { manufacturerId: "luxman", enabled: false },
      { manufacturerId: "custom-brand", baseUrl: "https://custom.example/" },
    ]),
  });
  assert.equal(definitions.has("luxman"), false);
  const custom = definitions.get("custom-brand");
  assert.ok(custom);
  assert.equal(custom[0].baseUrl, "https://custom.example/");
});

test("a malformed registry entry is ignored instead of being fetched", () => {
  const definitions = knowledgeSourceDefinitions({
    KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON: JSON.stringify([
      { manufacturerId: "bad-protocol", baseUrl: "javascript:alert(1)" },
      { manufacturerId: "no-base-url" },
    ]),
  });
  assert.equal(definitions.has("bad-protocol"), false);
  assert.equal(definitions.has("no-base-url"), false);
});

test("resolved definitions add the historical product indexes to a built-in source", () => {
  const definitions = resolveKnowledgeSourceDefinitions();
  const luxman = definitions.get("luxman");
  const accuphase = definitions.get("accuphase");
  const esoteric = definitions.get("esoteric");
  assert.ok(luxman);
  assert.ok(accuphase);
  assert.ok(esoteric);
  assert.equal(new Set(luxman[0].catalogUrls).has("https://www.luxman.co.jp/product/"), true);
  assert.ok(new Set(accuphase[0].catalogUrls).has("https://www.accuphase.com/history"));
  assert.ok(new Set(esoteric[0].catalogUrls).has("https://www.esoteric.jp/jp/support/discon"));
});

test("the expanded registry adds manufacturers without replacing the hand-checked ones", () => {
  assert.deepEqual(
    EXPANDED_OFFICIAL_SOURCES.map((source) => source.manufacturerId),
    EXPANDED_MANUFACTURERS,
  );

  const definitions = resolveKnowledgeSourceDefinitions();
  for (const manufacturerId of EXPANDED_MANUFACTURERS) {
    assert.equal(
      definitions.has(manufacturerId),
      true,
      `${manufacturerId} should have an official source`,
    );
  }

  // Eight hand-checked manufacturers plus the eleven the expansion added.
  assert.equal(definitions.size, 19);
});

test("deployment overrides keep disable and replacement semantics after expansion", () => {
  const env = {
    KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON: JSON.stringify([
      { manufacturerId: "stax", enabled: false },
      {
        manufacturerId: "focal",
        baseUrl: "https://official.example/",
        catalogUrls: ["https://official.example/catalog"],
      },
    ]),
  };

  // Deployment overrides must come last so they win over the expanded built-ins.
  const registryJson = expandedKnowledgeSourceEnv(env).KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON;
  assert.ok(registryJson);
  const registry: Array<{ manufacturerId: string; enabled?: boolean }> = JSON.parse(registryJson);
  assert.deepEqual(
    registry.slice(-2).map((entry) => entry.manufacturerId),
    ["stax", "focal"],
  );

  const definitions = resolveKnowledgeSourceDefinitions(env);
  assert.equal(definitions.has("stax"), false);
  const focalSources = definitions.get("focal");
  assert.ok(focalSources);
  assert.equal(focalSources[0].baseUrl, "https://official.example/");
});
