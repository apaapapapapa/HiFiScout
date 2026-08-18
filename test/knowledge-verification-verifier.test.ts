import test from "node:test";
import assert from "node:assert/strict";

import { CATEGORIES } from "../src/catalog/categories.js";
import {
  KNOWLEDGE_CATALOG_VERIFIER_VERSION,
  createKnowledgeSourceVerifier,
} from "../src/catalog/knowledge-verification/verifier.js";

function mappedFetch(pages: ReadonlyMap<string, string>, requested: string[] = []): typeof fetch {
  return async (url) => {
    requested.push(String(url));
    const body = pages.get(String(url));
    return new Response(body || "not found", { status: body ? 200 : 404 });
  };
}

function registryEnv(manufacturerId: string, catalogUrl: string, baseUrl: string) {
  return {
    KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON: JSON.stringify([
      { manufacturerId, baseUrl, catalogUrls: [catalogUrl] },
    ]),
  };
}

test("verification never widens the canonical UI taxonomy", () => {
  const ids = new Set<string>(CATEGORIES.map((category) => category.id));
  for (const verifierOnlyType of [
    "soundbar",
    "av_receiver",
    "clock_generator",
    "equalizer",
    "crossover",
    "tuner",
  ]) {
    assert.equal(ids.has(verifierOnlyType), false);
  }
});

test("an unregistered manufacturer reports no official source adapter", async () => {
  const verifier = createKnowledgeSourceVerifier(
    {},
    { fetchImpl: async () => new Response("not found", { status: 404 }) },
  );
  const result = await verifier.verifyCandidate({
    manufacturerId: "unknown-brand",
    observedModel: "ABC-1",
    normalizedModel: "ABC-1",
  });

  assert.equal(result.status, "unsupported");
  assert.equal(result.message, "no_official_source_adapter");
});

test("generic discovery finds a same-origin product link and stays on the official origin", async () => {
  const pages = new Map([
    [
      "https://example.com/catalog",
      '<html><body><a href="/products/ABC-1.html">ABC-1</a><a href="https://outside.example/ABC-1.html">outside</a></body></html>',
    ],
    [
      "https://example.com/products/ABC-1.html",
      `<html><head><title>ABC-1 Power Amplifier</title>
      <script type="application/ld+json">{"@type":"Product","name":"ABC-1 Power Amplifier","model":"ABC-1","category":"Power Amplifier"}</script>
      </head><body><h1>ABC-1 Power Amplifier</h1></body></html>`,
    ],
  ]);
  const requested: string[] = [];
  const verifier = createKnowledgeSourceVerifier(
    registryEnv("test-brand", "https://example.com/catalog", "https://example.com/"),
    { fetchImpl: mappedFetch(pages, requested) },
  );

  const result = await verifier.verifyCandidate({
    manufacturerId: "test-brand",
    normalizedModel: "ABC-1",
    observedManufacturer: "Test Brand",
    observedModel: "ABC-1",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "power_amp");
  const requestedUrls = new Set(requested);
  assert.equal(requestedUrls.has("https://example.com/catalog"), true);
  assert.equal(requestedUrls.has("https://example.com/products/ABC-1.html"), true);
  assert.ok(!requested.some((url) => url.startsWith("https://outside.example/")));
});

test("generic discovery matches model-bearing anchor text even when the URL is opaque", async () => {
  const pages = new Map([
    ["https://example.com/catalog", '<html><body><a href="/item/931">ABC-1</a></body></html>'],
    [
      "https://example.com/item/931",
      "<html><head><title>ABC-1 Power Amplifier</title></head><body><h1>ABC-1 Power Amplifier</h1></body></html>",
    ],
  ]);
  const requested: string[] = [];
  const verifier = createKnowledgeSourceVerifier(
    registryEnv("test-brand", "https://example.com/catalog", "https://example.com/"),
    { fetchImpl: mappedFetch(pages, requested) },
  );

  const result = await verifier.verifyCandidate({
    manufacturerId: "test-brand",
    normalizedModel: "ABC-1",
    observedManufacturer: "Test Brand",
    observedModel: "ABC-1",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "power_amp");
  assert.equal(new Set(requested).has("https://example.com/item/931"), true);
});

test("an official category index verifies a simplified model and keeps the listing identity", async () => {
  const pages = new Map([
    [
      "https://www.denon.com/ja-jp/category/turntables/",
      '<html><body><h1>Turntables</h1><div><a href="/item/dp400">DP-400</a></div></body></html>',
    ],
  ]);
  const requested: string[] = [];
  const verifier = createKnowledgeSourceVerifier(
    {},
    { fetchImpl: mappedFetch(pages, requested), fallbackEnabled: false },
  );
  const result = await verifier.verifyCandidate({
    manufacturerId: "denon",
    normalizedModel: "DP-400-BK [DP400BKEM]",
    observedManufacturer: "DENON",
    observedModel: "DP-400-BK [DP400BKEM]",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "turntable");
  assert.equal(result.canonicalModel, "DP-400-BK [DP400BKEM]");
});

test("the official index is consulted before generic discovery, which never runs on a hit", async () => {
  const pages = new Map([
    [
      "https://www.denon.com/ja-jp/category/turntables/",
      '<html><body><h1>Turntables</h1><div><a href="/item/dp400">DP-400</a></div></body></html>',
    ],
  ]);
  const requested: string[] = [];
  const verifier = createKnowledgeSourceVerifier({}, { fetchImpl: mappedFetch(pages, requested) });

  const result = await verifier.verifyCandidate({
    manufacturerId: "denon",
    normalizedModel: "DP-400",
    observedManufacturer: "DENON",
    observedModel: "DP-400",
  });

  assert.equal(result.status, "verified");
  // The registry catalog page is the generic strategy's entry point; reaching it would mean the
  // cheaper index route did not short-circuit.
  assert.equal(new Set(requested).has("https://www.denon.com/ja-jp/"), false);
});

test("an index that mentions the model without a category inherits the nearest heading", async () => {
  const history =
    "<html><body><h2>Tuner</h2><table><tr><td>T-11</td><td>FM Stereo Tuner</td></tr></table></body></html>";
  const fetchImpl: typeof fetch = async (url) =>
    new Response(String(url).includes("/history") ? history : "not found", {
      status: String(url).includes("/history") ? 200 : 404,
    });
  const verifier = createKnowledgeSourceVerifier({}, { fetchImpl, fallbackEnabled: false });
  const result = await verifier.verifyCandidate({
    manufacturerId: "accuphase",
    normalizedModel: "T-11",
    observedManufacturer: "Accuphase",
    observedModel: "T-11",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "other");
});

test("an ambiguous index result outranks a later strategy's plain miss", async () => {
  // The index names the model but states no category, so the model is real and only its category
  // is unusable — the outcome a reviewer can act on.
  const pages = new Map([
    ["https://www.luxman.co.jp/product/", "<html><body><ul><li>L-509Z</li></ul></body></html>"],
  ]);
  const verifier = createKnowledgeSourceVerifier({}, { fetchImpl: mappedFetch(pages) });

  const result = await verifier.verifyCandidate({
    manufacturerId: "luxman",
    normalizedModel: "L-509Z",
    observedManufacturer: "LUXMAN",
    observedModel: "L-509Z",
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.message, "official_page_has_no_unambiguous_category");
});

test("generic discovery reports the page it could not read instead of the placeholder", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    requested.push(String(url));
    if (String(url) === "https://example.com/catalog") {
      return new Response('<html><body><a href="/products/ABC-1.html">ABC-1</a></body></html>', {
        status: 200,
      });
    }
    if (String(url) === "https://example.com/products/ABC-1.html") {
      return new Response("boom", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  };
  const verifier = createKnowledgeSourceVerifier(
    registryEnv("test-brand", "https://example.com/catalog", "https://example.com/"),
    { fetchImpl },
  );

  const result = await verifier.verifyCandidate({
    manufacturerId: "test-brand",
    normalizedModel: "ABC-1",
    observedManufacturer: "Test Brand",
    observedModel: "ABC-1",
  });

  assert.equal(result.status, "error");
  assert.equal(result.message, "http_500");
  assert.equal(result.sourceUrl, "https://example.com/products/ABC-1.html");
});

test("disabling the fallback skips generic discovery entirely", async () => {
  const requested: string[] = [];
  const verifier = createKnowledgeSourceVerifier(
    registryEnv("test-brand", "https://example.com/catalog", "https://example.com/"),
    { fetchImpl: mappedFetch(new Map(), requested), fallbackEnabled: false },
  );

  const result = await verifier.verifyCandidate({
    manufacturerId: "test-brand",
    normalizedModel: "ABC-1",
    observedManufacturer: "Test Brand",
    observedModel: "ABC-1",
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.message, "official_product_page_not_discovered_v3");
  assert.deepEqual(requested, []);
});

test("a manufacturer strategy with its own source verifies before the registry is consulted", async () => {
  const officialIndex = "https://www.marantz.com/ja-jp/category/cd-sacd-players/";
  const pages = new Map([
    [
      officialIndex,
      "<html><body><section><h2>SACD 10</h2><p>リファレンスSACDプレーヤー</p></section></body></html>",
    ],
  ]);
  const requested: string[] = [];
  const verifier = createKnowledgeSourceVerifier(
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

test("generic discovery promotes a manufacturer that only the expanded registry supports", async () => {
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
  const requested: string[] = [];
  const verifier = createKnowledgeSourceVerifier({}, { fetchImpl: mappedFetch(pages, requested) });

  const result = await verifier.verifyCandidate({
    manufacturerId: "stax",
    normalizedModel: "SR-X9000",
    observedManufacturer: "STAX",
    observedModel: "SR-X9000",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "wired_headphone");
  const requestedUrls = new Set(requested);
  assert.equal(requestedUrls.has("https://stax.co.jp/product/"), true);
  assert.equal(requestedUrls.has("https://stax.co.jp/product/sr-x9000/"), true);
});

test("STAX SRM driver units stay in the headphone amplifier category", async () => {
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
  const verifier = createKnowledgeSourceVerifier({}, { fetchImpl: mappedFetch(pages) });

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

test("McIntosh MHA products stay in the headphone amplifier category", async () => {
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
  const verifier = createKnowledgeSourceVerifier({}, { fetchImpl: mappedFetch(pages) });

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

test("a stored source without a URL cannot be rechecked", async () => {
  const verifier = createKnowledgeSourceVerifier(
    {},
    { fetchImpl: async () => new Response("not found", { status: 404 }) },
  );
  const result = await verifier.verifyStoredSource({
    manufacturerId: "luxman",
    canonicalModel: "L-509Z",
    normalizedModel: "L-509Z",
  });

  assert.equal(result.status, "unsupported");
  assert.equal(result.message, "verified_product_has_no_source_url");
});

test("a stored source that has been removed is reported as not found", async () => {
  const verifier = createKnowledgeSourceVerifier(
    {},
    { fetchImpl: async () => new Response("gone", { status: 404 }) },
  );
  const result = await verifier.verifyStoredSource({
    manufacturerId: "luxman",
    canonicalModel: "L-509Z",
    normalizedModel: "L-509Z",
    sourceUrl: "https://www.luxman.co.jp/product/l-509z/",
    sourceType: "manufacturer_official",
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.httpStatus, 404);
  assert.equal(result.sourceUrl, "https://www.luxman.co.jp/product/l-509z/");
});

test("rechecking a stored source applies the same family category correction", async () => {
  const sourceUrl = "https://stax.co.jp/product/srm-d10-mk2/";
  const pages = new Map([
    [
      sourceUrl,
      "<html><head><title>SRM-D10 MK2</title></head><body><h1>SRM-D10 MK2 USB DAC内蔵ポータブル・ドライバー・ユニット</h1></body></html>",
    ],
  ]);
  const verifier = createKnowledgeSourceVerifier({}, { fetchImpl: mappedFetch(pages) });

  const result = await verifier.verifyStoredSource({
    manufacturerId: "stax",
    canonicalName: "STAX SRM-D10 MK2",
    canonicalModel: "SRM-D10 MK2",
    normalizedModel: "SRM-D10 MK2",
    sourceUrl,
    sourceType: "manufacturer_official",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "headphone_amp");
  assert.match(result.message, /official_family_v5/);
});

test("the rollout version is exposed for the one-shot catalog review", () => {
  assert.equal(KNOWLEDGE_CATALOG_VERIFIER_VERSION, 5);
});
