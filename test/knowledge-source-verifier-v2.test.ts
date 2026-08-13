import test from "node:test";
import assert from "node:assert/strict";

import {
  candidateModelVariants,
  containsFlexibleCatalogModelIdentity,
  createKnowledgeSourceVerifierV2,
  enhancedKnowledgeSourceDefinitions,
  verifyOfficialProductPageHtmlV2,
} from "../src/catalog/knowledge-source-verifier-v2.js";

test("v2 model identity tolerates safe separator variants without prefix collisions", () => {
  assert.equal(containsFlexibleCatalogModelIdentity("Marantz SACD30n", "SACD 30n"), true);
  assert.equal(containsFlexibleCatalogModelIdentity("LUXMAN D10X", "D-10X"), true);
  assert.equal(containsFlexibleCatalogModelIdentity("ESOTERIC K-01XD", "K-01X"), false);
});

test("v2 candidate variants remove a redundant manufacturer prefix conservatively", () => {
  assert.deepEqual(
    candidateModelVariants({
      manufacturerId: "tad",
      observedManufacturer: "TAD",
      observedModel: "TAD-D1000TX",
    }),
    ["TAD-D1000TX", "D1000TX"],
  );
});

test("v2 discovers a product from model-bearing anchor text even when the URL is opaque", async () => {
  const pages = new Map([
    ["https://example.com/catalog", '<html><body><a href="/item/931">ABC-1</a></body></html>'],
    [
      "https://example.com/item/931",
      "<html><head><title>ABC-1 Power Amplifier</title></head><body><h1>ABC-1 Power Amplifier</h1></body></html>",
    ],
  ]);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    const body = pages.get(String(url));
    return new Response(body || "not found", { status: body ? 200 : 404 });
  };
  const verifier = createKnowledgeSourceVerifierV2(
    {
      KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON: JSON.stringify([
        {
          manufacturerId: "test-brand",
          baseUrl: "https://example.com/",
          catalogUrls: ["https://example.com/catalog"],
        },
      ]),
    },
    { fetchImpl },
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

test("v2 uses model-local context on a grouped TAD page instead of mixing sibling categories", async () => {
  const result = await verifyOfficialProductPageHtmlV2({
    candidate: {
      manufacturerId: "tad",
      normalizedModel: "TAD-D1000TX",
      observedManufacturer: "TAD",
      observedModel: "TAD-D1000TX",
    },
    html: "<html><head><title>TAD D1000TX / DA1000TX</title></head><body><h1>Disc Player D1000TX / D/A Converter DA1000TX</h1></body></html>",
    sourceUrl: "https://tad-labs.com/jp/consumer/d1000tx_da1000tx/",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "cd_sacd_player");
  assert.deepEqual(result.categoryIds, ["cd_sacd_player"]);
});

test("v2 can use a nearby preceding official category label", async () => {
  const result = await verifyOfficialProductPageHtmlV2({
    candidate: {
      manufacturerId: "luxman",
      normalizedModel: "L-509Z",
      observedManufacturer: "LUXMAN",
      observedModel: "L-509Z",
    },
    html: "<html><head><title>LUXMAN L-509Z</title></head><body><div>プリメインアンプ</div><h1>L-509Z</h1></body></html>",
    sourceUrl: "https://www.luxman.co.jp/product/l-509z/",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "integrated_amp");
});

test("v2 built-in definitions add historical product indexes", () => {
  const definitions = enhancedKnowledgeSourceDefinitions();
  assert.equal(
    new Set(definitions.get("luxman")[0].catalogUrls).has("https://www.luxman.co.jp/product/"),
    true,
  );
  assert.ok(
    new Set(definitions.get("accuphase")[0].catalogUrls).has("https://www.accuphase.com/history"),
  );
  assert.ok(
    new Set(definitions.get("esoteric")[0].catalogUrls).has(
      "https://www.esoteric.jp/jp/support/discon",
    ),
  );
});
