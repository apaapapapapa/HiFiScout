import test from "node:test";
import assert from "node:assert/strict";
import {
  buildModelSearchAliases,
  identityModelParts,
  normalizeIdentityModel,
  resolveProductIdentity,
} from "../src/catalog/product-identity.js";

const TAD_D1000_MK2 = {
  id: 101,
  manufacturerId: "tad",
  canonicalModel: "D1000MK2",
  categoryIds: ["dac"],
  aliases: ["D-1000 MKII"],
};

for (const model of ["D1000MKII", "D1000 MK2", "D-1000 MKII", "D 1000 MK II"]) {
  test(`normalizes ${model} to D1000MK2`, () => {
    assert.equal(normalizeIdentityModel(model), "D1000MK2");
    assert.deepEqual(identityModelParts(model), {
      normalizedModel: "D1000MK2",
      modelStem: "D1000",
      variants: ["MK2"],
    });
  });
}

test("exact manufacturer/model identity resolves to the verified Knowledge Catalog product", () => {
  const resolution = resolveProductIdentity(
    { manufacturerId: "tad", model: "D1000 MK II", primaryCategoryId: "dac" },
    [TAD_D1000_MK2],
  );
  assert.equal(resolution.status, "matched");
  assert.equal(resolution.catalogProductId, 101);
  assert.equal(resolution.matchMethod, "manufacturer_model_exact");
});

for (const [left, right] of [
  ["D1000", "D1000MK2"],
  ["D1000MK2", "D1000TX"],
  ["805 D4", "805 D4 Signature"],
  ["LS50", "LS50 Meta"],
  ["C1", "C1X"],
]) {
  test(`variant veto prevents ${left} from merging with ${right}`, () => {
    const resolution = resolveProductIdentity(
      { manufacturerId: "maker", model: left, primaryCategoryId: "other" },
      [{ id: 1, manufacturerId: "maker", canonicalModel: right, aliases: [] }],
    );
    assert.equal(resolution.status, "unresolved");
    assert.equal(resolution.catalogProductId, null);
    assert.equal(resolution.matchMethod, "vetoed");
    assert.deepEqual(resolution.rejectedBy, ["variant_mismatch"]);
  });
}

test("fuzzy matching remains a candidate and never auto-merges", () => {
  const resolution = resolveProductIdentity(
    { manufacturerId: "tad", model: "D1000MK3", primaryCategoryId: "dac" },
    [{ id: 2, manufacturerId: "tad", canonicalModel: "D1000MK2", categoryIds: ["dac"] }],
  );
  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.catalogProductId, null);
});

test("model search aliases are bounded and include roman/numeric revision spellings", () => {
  const aliases = buildModelSearchAliases("D1000MKII");
  assert.ok(aliases.includes("D1000MK2"));
  assert.ok(aliases.includes("D1000 MKII"));
  assert.ok(aliases.includes("D-1000 MKII"));
  assert.ok(aliases.length <= 8);
});

test("ambiguous aliases never auto-merge", () => {
  const resolution = resolveProductIdentity(
    { manufacturerId: "maker", model: "MODEL-1 SPECIAL", primaryCategoryId: "dac" },
    [
      { id: 1, manufacturerId: "maker", canonicalModel: "MODEL1", aliases: ["MODEL-1 SPECIAL"] },
      { id: 2, manufacturerId: "maker", canonicalModel: "MODEL1SE", aliases: ["MODEL-1 SPECIAL"] },
    ],
  );
  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.catalogProductId, null);
  assert.equal(resolution.matchMethod, "alias_ambiguous");
  assert.deepEqual(resolution.rejectedBy, ["ambiguous_candidates"]);
});

test("stronger normalization collisions in verified catalog rows remain unresolved", () => {
  const resolution = resolveProductIdentity(
    { manufacturerId: "tad", model: "D1000 MK II", primaryCategoryId: "dac" },
    [
      { id: 1, manufacturerId: "tad", canonicalModel: "D1000MKII", aliases: [] },
      { id: 2, manufacturerId: "tad", canonicalModel: "D1000MK2", aliases: [] },
    ],
  );
  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.matchMethod, "exact_ambiguous");
});
