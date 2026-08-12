import test from "node:test";
import assert from "node:assert/strict";

import {
  containsCatalogModelIdentity,
  createKnowledgeSourceVerifier,
  knowledgeSourceDefinitions,
  verifyOfficialProductPageHtml,
} from "../src/catalog/knowledge-source-verifier.js";

test("model identity uses token boundaries and does not collapse distinct model names", () => {
  assert.equal(containsCatalogModelIdentity("K-01XD", "K-01XD"), true);
  assert.equal(containsCatalogModelIdentity("ESOTERIC K-01XD SACD Player", "K-01XD"), true);
  assert.equal(containsCatalogModelIdentity("ESOTERIC K-01XD SACD Player", "K-01X"), false);
  assert.equal(containsCatalogModelIdentity("Version 25 digital player", "2.5"), false);
  assert.equal(containsCatalogModelIdentity("Version 2.5 digital player", "2.5"), true);
});

test("official JSON-LD Product verifies exact model and category", async () => {
  const html = `<!doctype html>
    <html><head>
      <title>ESOTERIC K-01XD SACD/CD Player</title>
      <meta name="description" content="Reference SACD/CD player">
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Product","name":"K-01XD SACD/CD Player","model":"K-01XD","brand":{"@type":"Brand","name":"ESOTERIC"},"category":"SACD/CD Player"}
      </script>
    </head><body><h1>K-01XD SACD/CD Player</h1></body></html>`;

  const result = await verifyOfficialProductPageHtml({
    candidate: {
      manufacturerId: "esoteric",
      normalizedModel: "K-01XD",
      observedManufacturer: "ESOTERIC",
      observedModel: "K-01XD",
    },
    html,
    sourceUrl: "https://www.esoteric.jp/jp/product/k-01xd/",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.canonicalModel, "K-01XD");
  assert.equal(result.primaryCategoryId, "cd_sacd_player");
  assert.deepEqual(result.categoryIds, ["cd_sacd_player"]);
  assert.equal(result.contentHash.length, 64);
});

test("official page that confirms the model but not the category remains ambiguous", async () => {
  const html = `<html><head><title>ESOTERIC K-01XD</title>
    <script type="application/ld+json">{"@type":"Product","name":"K-01XD","model":"K-01XD","brand":{"name":"ESOTERIC"}}</script>
    </head><body><h1>K-01XD</h1></body></html>`;
  const result = await verifyOfficialProductPageHtml({
    candidate: {
      manufacturerId: "esoteric",
      normalizedModel: "K-01XD",
      observedManufacturer: "ESOTERIC",
      observedModel: "K-01XD",
    },
    html,
    sourceUrl: "https://example.invalid/k-01xd",
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.message, "official_page_has_no_unambiguous_category");
});

test("explicit conflicting JSON-LD brand blocks verification", async () => {
  const html = `<html><head><title>ESOTERIC K-01XD SACD Player</title>
    <script type="application/ld+json">{"@type":"Product","name":"K-01XD SACD Player","model":"K-01XD","brand":{"name":"Marantz"},"category":"SACD Player"}</script>
    </head><body><h1>K-01XD SACD Player</h1></body></html>`;
  const result = await verifyOfficialProductPageHtml({
    candidate: { manufacturerId: "esoteric", normalizedModel: "K-01XD", observedModel: "K-01XD" },
    html,
    sourceUrl: "https://example.invalid/k-01xd",
  });
  assert.equal(result.status, "ambiguous");
  assert.match(result.message, /brand_mismatch/);
});

test("generic official-site adapter discovers a same-origin product link and verifies it", async () => {
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
    ["https://example.com/robots.txt", "User-agent: *"],
    ["https://example.com/sitemap.xml", "<urlset></urlset>"],
  ]);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    const body = pages.get(String(url));
    return new Response(body || "not found", { status: body ? 200 : 404 });
  };
  const verifier = createKnowledgeSourceVerifier(
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
  assert.ok(requested.includes("https://example.com/catalog"));
  assert.ok(requested.includes("https://example.com/products/ABC-1.html"));
  assert.ok(!requested.some((url) => url.startsWith("https://outside.example/")));
});

test("source registry can disable a built-in manufacturer and add an external adapter", () => {
  const definitions = knowledgeSourceDefinitions({
    KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON: JSON.stringify([
      { manufacturerId: "luxman", enabled: false },
      { manufacturerId: "custom-brand", baseUrl: "https://custom.example/" },
    ]),
  });
  assert.equal(definitions.has("luxman"), false);
  assert.equal(definitions.get("custom-brand")[0].baseUrl, "https://custom.example/");
});
