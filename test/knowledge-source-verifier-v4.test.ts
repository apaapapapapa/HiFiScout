import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPANDED_OFFICIAL_SOURCES,
  KNOWLEDGE_CATALOG_VERIFIER_VERSION,
  createKnowledgeSourceVerifierV4,
  expandedKnowledgeSourceEnv,
} from "../src/catalog/knowledge-source-verifier-v4.js";

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

function mappedFetch(pages, requested = []) {
  return async (url) => {
    requested.push(String(url));
    const body = pages.get(String(url));
    return new Response(body || "not found", { status: body ? 200 : 404 });
  };
}

test("v5 rollout keeps the expanded official source registry without changing the canonical taxonomy", () => {
  assert.equal(KNOWLEDGE_CATALOG_VERIFIER_VERSION, 5);
  assert.deepEqual(
    EXPANDED_OFFICIAL_SOURCES.map((source) => source.manufacturerId),
    EXPANDED_MANUFACTURERS,
  );

  const verifier = createKnowledgeSourceVerifierV4(
    {},
    { fetchImpl: async () => new Response("not found", { status: 404 }) },
  );
  for (const manufacturerId of EXPANDED_MANUFACTURERS) {
    assert.equal(
      verifier.definitions.has(manufacturerId),
      true,
      `${manufacturerId} should have an official source`,
    );
  }

  // v3 already supports eight manufacturers; the expansion adds eleven without replacing them.
  assert.equal(verifier.definitions.size, 19);
});

test("deployment source overrides retain disable and replacement semantics after expansion", () => {
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
  const expanded = expandedKnowledgeSourceEnv(env);
  const registry = JSON.parse(expanded.KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON);
  assert.equal(registry.at(-2).manufacturerId, "stax");
  assert.equal(registry.at(-2).enabled, false);
  assert.equal(registry.at(-1).manufacturerId, "focal");

  const verifier = createKnowledgeSourceVerifierV4(env, {
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });
  assert.equal(verifier.definitions.has("stax"), false);
  assert.equal(verifier.definitions.get("focal")[0].baseUrl, "https://official.example/");
});

test("generic fallback can promote a newly supported manufacturer from its official product index", async () => {
  const pages = new Map([
    [
      "https://stax.co.jp/product/",
      '<html><body><a href="/product/sr-x9000/">SR-X9000</a></body></html>',
    ],
    [
      "https://stax.co.jp/product/sr-x9000/",
      "<html><head><title>SR-X9000 Headphones</title></head><body><h1>SR-X9000 Headphones</h1></body></html>",
    ],
  ]);
  const requested = [];
  const verifier = createKnowledgeSourceVerifierV4(
    {},
    { fetchImpl: mappedFetch(pages, requested) },
  );

  const result = await verifier.verifyCandidate({
    manufacturerId: "stax",
    normalizedModel: "SR-X9000",
    observedManufacturer: "STAX",
    observedModel: "SR-X9000",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "headphone");
  const requestedUrls = new Set(requested);
  assert.equal(requestedUrls.has("https://stax.co.jp/product/"), true);
  assert.equal(requestedUrls.has("https://stax.co.jp/product/sr-x9000/"), true);
});

test("Marantz SACD10 retailer suffix is verified from the current official CD/SACD index", async () => {
  const officialIndex = "https://www.marantz.com/ja-jp/category/cd-sacd-players/";
  const pages = new Map([
    [
      officialIndex,
      "<html><body><section><h2>SACD 10</h2><p>リファレンスSACDプレーヤー</p></section></body></html>",
    ],
  ]);
  const requested = [];
  const verifier = createKnowledgeSourceVerifierV4(
    {},
    { fetchImpl: mappedFetch(pages, requested), fallbackEnabled: false },
  );

  const result = await verifier.verifyCandidate({
    manufacturerId: "marantz",
    normalizedModel: "SACD10/FB",
    observedManufacturer: "Marantz",
    observedModel: "SACD10/FB",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.canonicalModel, "SACD10/FB");
  assert.equal(result.primaryCategoryId, "cd_sacd_player");
  assert.deepEqual(result.categoryIds, ["cd_sacd_player"]);
  assert.equal(result.sourceUrl, officialIndex);
  assert.match(result.message, /marantz_cd_sacd_index_v5/);
  assert.deepEqual(requested, [officialIndex]);
});

test("v5 keeps STAX SRM driver units in the headphone amplifier category", async () => {
  const pages = new Map([
    [
      "https://stax.co.jp/product/",
      '<html><body><a href="/product/srm-d10-mk2/">SRM-D10 MK2</a></body></html>',
    ],
    [
      "https://stax.co.jp/product/srm-d10-mk2/",
      "<html><head><title>SRM-D10 MK2</title></head><body><h1>SRM-D10 MK2 USB DAC内蔵ポータブル・ドライバー・ユニット</h1></body></html>",
    ],
  ]);
  const verifier = createKnowledgeSourceVerifierV4({}, { fetchImpl: mappedFetch(pages) });

  const result = await verifier.verifyCandidate({
    manufacturerId: "stax",
    normalizedModel: "SRM-D10 MK2",
    observedManufacturer: "STAX",
    observedModel: "SRM-D10 MK2",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "headphone_amp");
  assert.deepEqual(result.categoryIds, ["headphone_amp"]);
  assert.match(result.message, /official_family_v5/);
});

test("v5 keeps McIntosh MHA products in the headphone amplifier category", async () => {
  const pages = new Map([
    [
      "https://www.mcintoshlabs.com/products/amplifiers",
      '<html><body><a href="/products/amplifiers/MHA200">MHA200</a></body></html>',
    ],
    [
      "https://www.mcintoshlabs.com/products/amplifiers/MHA200",
      "<html><head><title>MHA200 2-Channel Headphone Power Amplifier</title></head><body><h1>MHA200 2-Channel Headphone Power Amplifier</h1></body></html>",
    ],
  ]);
  const verifier = createKnowledgeSourceVerifierV4({}, { fetchImpl: mappedFetch(pages) });

  const result = await verifier.verifyCandidate({
    manufacturerId: "mcintosh",
    normalizedModel: "MHA200",
    observedManufacturer: "McIntosh",
    observedModel: "MHA200",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "headphone_amp");
  assert.deepEqual(result.categoryIds, ["headphone_amp"]);
  assert.match(result.message, /official_family_v5/);
});
