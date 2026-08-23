import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  applyManufacturerResolution,
  resolveManufacturer,
} from "../src/catalog/manufacturer-resolver.js";
import { resolveProductIdentity } from "../src/catalog/product-identity.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import type { ManufacturerAliasEvidence } from "../src/catalog/types.js";
import { parsedProduct } from "./helpers/fixtures.js";

function alias(overrides: Partial<ManufacturerAliasEvidence> = {}): ManufacturerAliasEvidence {
  return {
    manufacturerId: "example-audio",
    canonicalName: "Example Audio",
    alias: "Example Audio Japan",
    normalizedAlias: "exampleaudiojapan",
    verificationStatus: "verified",
    source: "manual_verified",
    ruleVersion: 2,
    ...overrides,
  };
}

test("manufacturer keys apply NFKC, case, punctuation and legal-entity normalization", () => {
  const result = resolveManufacturer({
    rawManufacturer: "ＡＣＣＵＰＨＡＳＥ Co., Ltd.",
  });

  assert.equal(result.status, "resolved");
  assert.equal(result.canonicalManufacturerId, "accuphase");
  assert.equal(result.method, "bootstrap_alias");
  assert.equal(result.confidence, "high");
});

test("MSB spellings and seller condition badges resolve to MSB Technology", () => {
  const cases = [
    ["MSB", "msb"],
    ["MSB Technology", "msbtechnology"],
    ["【中古品】MSB", "msb"],
    ["[中古品] MSB", "msb"],
  ] as const;

  for (const [rawManufacturer, normalizedRawManufacturer] of cases) {
    const result = resolveManufacturer({ rawManufacturer });
    assert.equal(result.status, "resolved");
    assert.equal(result.canonicalManufacturerId, "msb-technology");
    assert.equal(result.displayName, "MSB Technology");
    assert.equal(result.method, "bootstrap_alias");
    assert.equal(result.normalizedRawManufacturer, normalizedRawManufacturer);
  }
});

test("a verified operational alias resolves to its canonical manufacturer", () => {
  const result = resolveManufacturer({ rawManufacturer: "Example-Audio Japan" }, [
    alias({ alias: "Example Audio Japan", normalizedAlias: "exampleaudiojapan" }),
  ]);

  assert.equal(result.status, "resolved");
  assert.equal(result.canonicalManufacturerId, "example-audio");
  assert.equal(result.displayName, "Example Audio");
  assert.equal(result.method, "verified_alias");
});

test("pending and ambiguous aliases remain candidates without a canonical id", () => {
  const pending = resolveManufacturer({ rawManufacturer: "Shared Audio" }, [
    alias({
      alias: "Shared Audio",
      normalizedAlias: "sharedaudio",
      verificationStatus: "pending",
    }),
  ]);
  assert.equal(pending.status, "candidate");
  assert.equal(pending.method, "unverified_alias");
  assert.equal(pending.canonicalManufacturerId, "");

  const ambiguous = resolveManufacturer({ rawManufacturer: "Shared Audio" }, [
    alias({ alias: "Shared Audio", normalizedAlias: "sharedaudio" }),
    alias({
      manufacturerId: "other-audio",
      canonicalName: "Other Audio",
      alias: "Shared Audio",
      normalizedAlias: "sharedaudio",
    }),
  ]);
  assert.equal(ambiguous.status, "candidate");
  assert.equal(ambiguous.method, "ambiguous_alias");
  assert.equal(ambiguous.canonicalManufacturerId, "");
  assert.deepEqual(ambiguous.candidateManufacturerIds, ["example-audio", "other-audio"]);
});

test("title evidence resolves only when the explicit seller manufacturer is missing", () => {
  const fromTitle = resolveManufacturer({ rawManufacturer: "", title: "TAD D1000 MK2" });
  assert.equal(fromTitle.status, "resolved");
  assert.equal(fromTitle.canonicalManufacturerId, "tad");
  assert.equal(fromTitle.method, "title_bootstrap_alias");

  const explicitUnknown = resolveManufacturer({
    rawManufacturer: "Unknown Distributor",
    title: "TAD D1000 MK2",
  });
  assert.equal(explicitUnknown.status, "unresolved");
  assert.equal(explicitUnknown.canonicalManufacturerId, "");

  const noTokenBoundary = resolveManufacturer({ rawManufacturer: "", title: "Tadpole Model 1" });
  assert.equal(noTokenBoundary.status, "unresolved");
});

test("similar spelling alone never becomes a canonical manufacturer", () => {
  const result = resolveManufacturer({ rawManufacturer: "Accuphaze" });
  assert.equal(result.status, "unresolved");
  assert.equal(result.canonicalManufacturerId, "");
});

test("re-resolution preserves raw seller evidence", () => {
  const product = normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "Example Audio Japan",
      rawManufacturer: "Example Audio Japan",
      model: "X-1",
      title: "Example Audio Japan X-1",
    }),
  );
  const resolved = applyManufacturerResolution(product, [alias()]);

  assert.equal(resolved.rawManufacturer, "Example Audio Japan");
  assert.equal(resolved.rawModel, "X-1");
  assert.equal(resolved.manufacturerId, "example-audio");
  assert.equal(resolved.manufacturerResolutionStatus, "resolved");
});

test("a corrected manufacturer enables only the existing safe exact identity match", () => {
  const before = resolveManufacturer({ rawManufacturer: "TAD Laboratories" });
  assert.equal(before.status, "unresolved");

  const corrected = resolveManufacturer({ rawManufacturer: "TAD Laboratories" }, [
    alias({
      manufacturerId: "tad",
      canonicalName: "TAD",
      alias: "TAD Laboratories",
      normalizedAlias: "tadlaboratories",
    }),
  ]);
  const identity = resolveProductIdentity(
    { manufacturerId: corrected.canonicalManufacturerId, model: "D-1000 MKII" },
    [
      {
        id: 812,
        manufacturerId: "tad",
        canonicalModel: "D1000 MK2",
        aliases: [],
      },
    ],
  );

  assert.equal(corrected.status, "resolved");
  assert.equal(identity.status, "matched");
  assert.equal(identity.catalogProductId, 812);
  assert.equal(identity.matchMethod, "manufacturer_model_exact");
});
