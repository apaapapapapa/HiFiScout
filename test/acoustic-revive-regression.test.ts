import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { resolveManufacturer } from "../src/catalog/manufacturer-resolver.js";
import {
  normalizeManufacturer,
  splitKnownManufacturerModel,
} from "../src/catalog/manufacturers.js";
import { MODEL_RESOLVER_VERSION, resolveModel } from "../src/catalog/model-resolver.js";
import { parseTereonListing } from "../src/crawler/shops/tereon.js";
import { splitManufacturerModel } from "../src/crawler/normalize.js";

test("ACOUSTIC REVIVE is a canonical multi-word manufacturer", () => {
  assert.deepEqual(normalizeManufacturer("ACOUSTIC REVIVE"), {
    id: "acoustic-revive",
    displayName: "ACOUSTIC REVIVE",
    matchedAlias: true,
  });

  assert.deepEqual(splitKnownManufacturerModel("ACOUSTIC REVIVE BWA-4"), {
    id: "acoustic-revive",
    displayName: "ACOUSTIC REVIVE",
    rawManufacturer: "ACOUSTIC REVIVE",
    model: "BWA-4",
  });

  assert.deepEqual(splitManufacturerModel("ACOUSTIC REVIVE BWA-4", "tereon"), {
    manufacturer: "ACOUSTIC REVIVE",
    model: "BWA-4",
  });
});

test("legacy ACOUSTIC first-token evidence re-resolves from the full title", () => {
  // Stored rows created before this manufacturer was known must converge without a fresh crawl.
  const result = resolveManufacturer({
    rawManufacturer: "ACOUSTIC",
    manufacturerCandidate: "ACOUSTIC",
    title: "ACOUSTIC REVIVE BWA-4",
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.canonicalManufacturerId, "acoustic-revive");
  assert.equal(result.displayName, "ACOUSTIC REVIVE");
  assert.equal(result.method, "title_bootstrap_alias");
});

test("legacy truncated manufacturer tail is removed from the stored model", () => {
  // Advancing the resolver version makes already-stamped rows eligible for the repair replay.
  assert.equal(MODEL_RESOLVER_VERSION, 10);

  const result = resolveModel({
    rawModel: "REVIVE BWA-4",
    title: "ACOUSTIC REVIVE BWA-4",
    manufacturerId: "acoustic-revive",
    shopKey: "tereon",
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.rawModel, "REVIVE BWA-4");
  assert.equal(result.model, "BWA-4");
  assert.equal(result.method, "seller_model");

  const unrelatedPrefix = resolveModel({
    rawModel: "REFERENCE BWA-4",
    title: "ACOUSTIC REVIVE BWA-4",
    manufacturerId: "acoustic-revive",
    shopKey: "tereon",
  });
  assert.equal(unrelatedPrefix.model, "REFERENCE BWA-4");
});

test("Tereon keeps ACOUSTIC REVIVE separate from the BWA-4 model", () => {
  const html = `
    <div>
      <a href="/shopdetail/000000008999/004/X/page1/order/">中古品：ACOUSTIC REVIVE BWA-4</a>
      ACOUSTIC REVIVE 29,800円（税込）
    </div>`;

  const [item] = parseTereonListing(html, {
    url: "https://www.tereon-tsuhan.com/shopbrand/004/X/",
    page: 1,
    conditionCode: "004",
    conditionText: "中古品",
  });

  assert.ok(item);
  assert.equal(item.title, "ACOUSTIC REVIVE BWA-4");
  assert.equal(item.rawManufacturer, "ACOUSTIC REVIVE");
  assert.equal(item.manufacturer, "ACOUSTIC REVIVE");
  assert.equal(item.model, "BWA-4");
});
