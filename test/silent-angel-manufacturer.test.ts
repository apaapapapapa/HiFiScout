import assert from "node:assert/strict";
import test from "node:test";

import {
  MANUFACTURER_RESOLVER_VERSION,
  resolveManufacturer,
} from "../src/catalog/manufacturer-resolver.js";
import {
  normalizeManufacturer,
  splitKnownManufacturerModel,
} from "../src/catalog/manufacturers.js";
import { splitManufacturerModel } from "../src/crawler/normalize.js";

test("Silent Angel is a canonical multi-word manufacturer", () => {
  assert.deepEqual(normalizeManufacturer("Silent Angel"), {
    id: "silent-angel",
    displayName: "Silent Angel",
    matchedAlias: true,
  });

  assert.deepEqual(splitKnownManufacturerModel("Silent Angel Munich M1"), {
    id: "silent-angel",
    displayName: "Silent Angel",
    rawManufacturer: "Silent Angel",
    model: "Munich M1",
  });

  assert.deepEqual(splitManufacturerModel("Silent Angel Munich M1", "generic"), {
    manufacturer: "Silent Angel",
    model: "Munich M1",
  });
});

test("resolver repairs the legacy first-token Silent manufacturer without rewriting raw evidence", () => {
  const result = resolveManufacturer({
    rawManufacturer: "Silent",
    manufacturerCandidate: "Silent",
    title: "Silent Angel Munich M1",
  });

  assert.equal(MANUFACTURER_RESOLVER_VERSION, 5);
  assert.equal(result.status, "resolved");
  assert.equal(result.canonicalManufacturerId, "silent-angel");
  assert.equal(result.displayName, "Silent Angel");
  assert.equal(result.normalizedRawManufacturer, "silent");
  assert.equal(result.method, "title_bootstrap_alias");
});

test("title evidence still cannot override arbitrary explicit manufacturer text", () => {
  const result = resolveManufacturer({
    rawManufacturer: "Unknown Distributor",
    manufacturerCandidate: "Unknown Distributor",
    title: "Silent Angel Munich M1",
  });

  assert.equal(result.status, "unresolved");
  assert.equal(result.canonicalManufacturerId, "");
});
