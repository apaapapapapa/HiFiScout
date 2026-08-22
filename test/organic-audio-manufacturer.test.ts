import assert from "node:assert/strict";
import test from "node:test";

import { resolveManufacturer } from "../src/catalog/manufacturer-resolver.js";
import {
  normalizeManufacturer,
  splitKnownManufacturerModel,
} from "../src/catalog/manufacturers.js";
import { splitManufacturerModel } from "../src/crawler/normalize.js";

test("Organic Audio is a canonical multi-word manufacturer", () => {
  assert.deepEqual(normalizeManufacturer("Organic Audio"), {
    id: "organic-audio",
    displayName: "Organic Audio",
    matchedAlias: true,
  });

  assert.deepEqual(splitKnownManufacturerModel("Organic Audio Reference Series Interconnect RCA"), {
    id: "organic-audio",
    displayName: "Organic Audio",
    rawManufacturer: "Organic Audio",
    model: "Reference Series Interconnect RCA",
  });

  assert.deepEqual(
    splitManufacturerModel("Organic Audio Reference Series Interconnect RCA", "generic"),
    {
      manufacturer: "Organic Audio",
      model: "Reference Series Interconnect RCA",
    },
  );
});

test("legacy first-token Organic evidence resolves to Organic Audio", () => {
  const result = resolveManufacturer({
    rawManufacturer: "Organic",
    manufacturerCandidate: "Organic",
    title: "Organic Audio Reference Series Interconnect RCA",
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.canonicalManufacturerId, "organic-audio");
  assert.equal(result.displayName, "Organic Audio");
  assert.equal(result.method, "bootstrap_alias");
});
