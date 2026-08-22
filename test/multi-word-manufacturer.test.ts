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

interface MultiWordManufacturerCase {
  readonly canonicalName: string;
  readonly id: string;
  readonly legacyName: string;
  readonly model: string;
  readonly shopKey: string;
  readonly resolverMethod: string;
  readonly assertNormalizedLegacy?: boolean;
}

const CASES: readonly MultiWordManufacturerCase[] = [
  {
    canonicalName: "CAMELOT TECHNOLOGY",
    id: "camelot-technology",
    legacyName: "CAMELOT",
    model: "PM-780",
    shopKey: "tereon",
    resolverMethod: "bootstrap_alias",
  },
  {
    canonicalName: "Organic Audio",
    id: "organic-audio",
    legacyName: "Organic",
    model: "Reference Series Interconnect RCA",
    shopKey: "generic",
    resolverMethod: "bootstrap_alias",
  },
  {
    canonicalName: "Silent Angel",
    id: "silent-angel",
    legacyName: "Silent",
    model: "Munich M1",
    shopKey: "generic",
    resolverMethod: "title_bootstrap_alias",
    assertNormalizedLegacy: true,
  },
];

for (const scenario of CASES) {
  const title = `${scenario.canonicalName} ${scenario.model}`;

  test(`${scenario.canonicalName} is a canonical multi-word manufacturer`, () => {
    assert.deepEqual(normalizeManufacturer(scenario.canonicalName), {
      id: scenario.id,
      displayName: scenario.canonicalName,
      matchedAlias: true,
    });

    assert.deepEqual(splitKnownManufacturerModel(title), {
      id: scenario.id,
      displayName: scenario.canonicalName,
      rawManufacturer: scenario.canonicalName,
      model: scenario.model,
    });

    assert.deepEqual(splitManufacturerModel(title, scenario.shopKey), {
      manufacturer: scenario.canonicalName,
      model: scenario.model,
    });
  });

  test(`legacy first-token ${scenario.legacyName} evidence resolves to ${scenario.canonicalName}`, () => {
    const result = resolveManufacturer({
      rawManufacturer: scenario.legacyName,
      manufacturerCandidate: scenario.legacyName,
      title,
    });

    assert.equal(result.status, "resolved");
    assert.equal(result.canonicalManufacturerId, scenario.id);
    assert.equal(result.displayName, scenario.canonicalName);
    assert.equal(result.method, scenario.resolverMethod);
    if (scenario.assertNormalizedLegacy) {
      assert.equal(result.normalizedRawManufacturer, scenario.legacyName.toLowerCase());
    }
  });
}

test("multi-word manufacturer repair remains on resolver version 7", () => {
  assert.equal(MANUFACTURER_RESOLVER_VERSION, 7);
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
