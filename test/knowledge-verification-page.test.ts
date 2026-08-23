import { test } from "vitest";
import assert from "node:assert/strict";

import { verifyOfficialProductPage } from "../src/catalog/knowledge-verification/page-verification.js";

test("official JSON-LD Product verifies exact model and category", async () => {
  const html = `<!doctype html>
    <html><head>
      <title>ESOTERIC K-01XD SACD/CD Player</title>
      <meta name="description" content="Reference SACD/CD player">
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Product","name":"K-01XD SACD/CD Player","model":"K-01XD","brand":{"@type":"Brand","name":"ESOTERIC"},"category":"SACD/CD Player"}
      </script>
    </head><body><h1>K-01XD SACD/CD Player</h1></body></html>`;

  const result = await verifyOfficialProductPage({
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

test("official title and h1 can verify a model when JSON-LD is absent", async () => {
  const result = await verifyOfficialProductPage({
    candidate: {
      manufacturerId: "esoteric",
      normalizedModel: "K-01XD",
      observedManufacturer: "ESOTERIC",
      observedModel: "K-01XD",
    },
    html: "<html><head><title>ESOTERIC K-01XD SACD Player</title></head><body><h1>K-01XD SACD Player</h1></body></html>",
    sourceUrl: "https://example.invalid/k-01xd",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "cd_sacd_player");
});

test("official page that confirms the model but not the category remains ambiguous", async () => {
  const html = `<html><head><title>ESOTERIC K-01XD</title>
    <script type="application/ld+json">{"@type":"Product","name":"K-01XD","model":"K-01XD","brand":{"name":"ESOTERIC"}}</script>
    </head><body><h1>K-01XD</h1></body></html>`;
  const result = await verifyOfficialProductPage({
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

test("global navigation near a model cannot become category evidence", async () => {
  const html = `<html><head>
      <title>FOSTEX T60RP</title>
      <meta name="description" content="T60RP is a wired headphone using an RP planar magnetic driver">
    </head><body>
      <nav>Products / Headphone Amplifier / T60RP / Speakers / Cable</nav>
      <h1>T60RP</h1>
      <div class="breadcrumb">Home &gt; Headphones &gt; T60RP</div>
    </body></html>`;
  const result = await verifyOfficialProductPage({
    candidate: {
      manufacturerId: "fostex",
      normalizedModel: "T60RP",
      observedManufacturer: "FOSTEX",
      observedModel: "T60RP",
    },
    html,
    sourceUrl: "https://example.invalid/t60rp",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.primaryCategoryId, "wired_headphone");
});

test("navigation-only category text leaves a confirmed model ambiguous", async () => {
  const html = `<html><head><title>STAX SR-L700 MK2</title></head><body>
    <nav>Cable / Headphone Amplifier / SR-L700 MK2 / Accessories</nav>
    <h1>SR-L700 MK2</h1>
    </body></html>`;
  const result = await verifyOfficialProductPage({
    candidate: {
      manufacturerId: "stax",
      normalizedModel: "SR-L700 MK2",
      observedManufacturer: "STAX",
      observedModel: "SR-L700 MK2",
    },
    html,
    sourceUrl: "https://example.invalid/sr-l700-mk2",
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.message, "official_page_has_no_unambiguous_category");
});

test("a page about a different model is not found rather than ambiguous", async () => {
  const result = await verifyOfficialProductPage({
    candidate: {
      manufacturerId: "esoteric",
      normalizedModel: "K-01XD",
      observedManufacturer: "ESOTERIC",
      observedModel: "K-01XD",
    },
    html: "<html><head><title>ESOTERIC N-05XD Network DAC</title></head><body><h1>N-05XD</h1></body></html>",
    sourceUrl: "https://example.invalid/n-05xd",
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.message, "official_page_does_not_confirm_model");
});

test("explicit conflicting JSON-LD brand blocks verification", async () => {
  const html = `<html><head><title>ESOTERIC K-01XD SACD Player</title>
    <script type="application/ld+json">{"@type":"Product","name":"K-01XD SACD Player","model":"K-01XD","brand":{"name":"Marantz"},"category":"SACD Player"}</script>
    </head><body><h1>K-01XD SACD Player</h1></body></html>`;
  const result = await verifyOfficialProductPage({
    candidate: { manufacturerId: "esoteric", normalizedModel: "K-01XD", observedModel: "K-01XD" },
    html,
    sourceUrl: "https://example.invalid/k-01xd",
  });
  assert.equal(result.status, "ambiguous");
  assert.match(result.message, /brand_mismatch/);
});

test("model-local context wins over a sibling product on a grouped page", async () => {
  const result = await verifyOfficialProductPage({
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

test("a nearby preceding official category label classifies the model", async () => {
  const result = await verifyOfficialProductPage({
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
