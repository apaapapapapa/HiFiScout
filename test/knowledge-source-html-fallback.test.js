import test from "node:test";
import assert from "node:assert/strict";

import { verifyOfficialProductPageHtml } from "../src/catalog/knowledge-source-verifier.js";

test("official title and h1 can verify a model when JSON-LD is absent", async () => {
  const result = await verifyOfficialProductPageHtml({
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
