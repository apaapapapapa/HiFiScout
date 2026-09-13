import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  MANUFACTURER_RESOLVER_VERSION,
  resolveManufacturer,
} from "../src/catalog/manufacturer-resolver.js";
import { resolveModel } from "../src/catalog/model-resolver.js";
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
  readonly titleManufacturer?: string;
  readonly parsedManufacturer?: string;
  readonly assertNormalizedLegacy?: boolean;
}

const CASES: readonly MultiWordManufacturerCase[] = [
  {
    canonicalName: "Counterpoint",
    id: "counterpoint",
    legacyName: "Counter",
    model: "SA-3",
    shopKey: "afroaudio",
    resolverMethod: "title_bootstrap_alias",
    titleManufacturer: "Counter Point",
    parsedManufacturer: "Counter Point",
  },
  {
    canonicalName: "Golden Dragon",
    id: "golden-dragon",
    legacyName: "Golden",
    model: "KT88 4本",
    shopKey: "afroaudio",
    resolverMethod: "title_bootstrap_alias",
  },
  {
    canonicalName: "Unison Research",
    id: "unisonresearch",
    legacyName: "Unison",
    model: "Simply Four",
    shopKey: "shimamusen",
    resolverMethod: "title_bootstrap_alias",
  },
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
  const title = `${scenario.titleManufacturer || scenario.canonicalName} ${scenario.model}`;
  const parsedManufacturer = scenario.parsedManufacturer || scenario.canonicalName;

  test(`${scenario.canonicalName} is a canonical multi-word manufacturer`, () => {
    assert.deepEqual(normalizeManufacturer(scenario.canonicalName), {
      id: scenario.id,
      displayName: scenario.canonicalName,
      matchedAlias: true,
    });

    assert.deepEqual(splitKnownManufacturerModel(title), {
      id: scenario.id,
      displayName: scenario.canonicalName,
      rawManufacturer: parsedManufacturer,
      model: scenario.model,
    });

    assert.deepEqual(splitManufacturerModel(title, scenario.shopKey), {
      manufacturer: parsedManufacturer,
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

  test(`legacy ${scenario.canonicalName} model evidence drops the remaining manufacturer tokens`, () => {
    const legacyModel = title.split(/\s+/u).slice(1).join(" ");
    const result = resolveModel({
      rawManufacturer: scenario.legacyName,
      rawModel: legacyModel,
      title,
      manufacturerId: scenario.id,
      shopKey: scenario.shopKey,
    });

    assert.equal(result.status, "resolved");
    assert.equal(result.model, scenario.model);
  });
}

test("rows written before the multi-word manufacturer repair stay replay-eligible", () => {
  // The repair shipped at resolver version 7. Later bootstrap-catalog changes bump the version
  // again, and every bump keeps the pre-repair rows below it eligible for replay.
  assert.ok(MANUFACTURER_RESOLVER_VERSION >= 7);
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
