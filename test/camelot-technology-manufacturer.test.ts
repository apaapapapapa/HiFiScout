import assert from "node:assert/strict";
import test from "node:test";

import { resolveManufacturer } from "../src/catalog/manufacturer-resolver.js";
import {
  normalizeManufacturer,
  splitKnownManufacturerModel,
} from "../src/catalog/manufacturers.js";
import { splitManufacturerModel } from "../src/crawler/normalize.js";

test("CAMELOT TECHNOLOGY is a canonical multi-word manufacturer", () => {
  assert.deepEqual(normalizeManufacturer("CAMELOT TECHNOLOGY"), {
    id: "camelot-technology",
    displayName: "CAMELOT TECHNOLOGY",
    matchedAlias: true,
  });

  assert.deepEqual(splitKnownManufacturerModel("CAMELOT TECHNOLOGY PM-780"), {
    id: "camelot-technology",
    displayName: "CAMELOT TECHNOLOGY",
    rawManufacturer: "CAMELOT TECHNOLOGY",
    model: "PM-780",
  });

  assert.deepEqual(splitManufacturerModel("CAMELOT TECHNOLOGY PM-780", "tereon"), {
    manufacturer: "CAMELOT TECHNOLOGY",
    model: "PM-780",
  });
});

test("legacy first-token CAMELOT evidence resolves to CAMELOT TECHNOLOGY", () => {
  const result = resolveManufacturer({
    rawManufacturer: "CAMELOT",
    manufacturerCandidate: "CAMELOT",
    title: "CAMELOT TECHNOLOGY PM-780",
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.canonicalManufacturerId, "camelot-technology");
  assert.equal(result.displayName, "CAMELOT TECHNOLOGY");
  assert.equal(result.method, "bootstrap_alias");
});
