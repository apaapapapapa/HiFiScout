import assert from "node:assert/strict";
import test from "node:test";
import {
  applyModelResolution,
  createModelResolver,
  MODEL_RESOLVER_VERSION,
  resolveModel,
} from "../src/catalog/model-resolver.js";
import { normalizeIdentityModel, resolveProductIdentity } from "../src/catalog/product-identity.js";
import type { ManufacturerAliasEvidence, NormalizedCatalogProduct } from "../src/catalog/types.js";

function resolve(rawModel: string, manufacturerId = "tad", title = "") {
  return resolveModel({ rawModel, title, manufacturerId });
}

test("seller annotations are removed only through the explicit vocabulary", () => {
  const cases: [string, string, string][] = [
    ["D-1000 中古美品", "D-1000", "condition"],
    ["D-1000 USED", "D-1000", "condition"],
    ["D-1000 【売約済】", "D-1000", "listing_state"],
    ["D-1000 SOLD OUT", "D-1000", "listing_state"],
    ["D-1000 元箱付", "D-1000", "packaging"],
    ["D-1000 リモコン付", "D-1000", "packaging"],
    ["D-1000 [ABC-12345]", "D-1000", "seller_sku"],
    ["D-1000 管理番号:AB1234", "D-1000", "seller_sku"],
    ["D-1000 / シルバー", "D-1000", "presentation_color"],
    ["D-1000 (BK)", "D-1000", "presentation_color"],
  ];
  for (const [input, expected, rule] of cases) {
    const result = resolve(input);
    assert.equal(result.model, expected, input);
    assert.equal(result.status, "resolved", input);
    assert.deepEqual(result.removedAnnotations, [rule], input);
    assert.equal(result.method, "seller_model_annotated", input);
  }
});

test("raw model presentation is preserved when the display model is cleaned", () => {
  const result = resolve("D-1000 MK2 中古美品");

  assert.equal(result.rawModel, "D-1000 MK2 中古美品");
  assert.equal(result.model, "D-1000 MK2");
  assert.equal(result.normalizedModel, "D1000MK2");
});

test("normalized model is deterministic across punctuation and spacing variants", () => {
  const variants = ["D-1000 MK2", "D‐1000　MKII", "d1000 mark ii", "D_1000 MK2"];
  const normalized = new Set(variants.map((variant) => resolve(variant).normalizedModel));

  assert.deepEqual([...normalized], ["D1000MK2"]);
});

test("revision and edition variants stay distinct", () => {
  const pairs: [string, string][] = [
    ["D1000", "D1000 MK2"],
    ["D1000 MK2", "D1000 MK3"],
    ["D1000 MK2", "D1000 TX"],
    ["805 D4", "805 D4 Signature"],
    ["LS50", "LS50 Meta"],
    ["C1", "C1X"],
    ["E-800", "E-800 SE"],
    ["E-800", "E-800 Limited"],
    ["E-800", "E-800 Reference"],
    ["E-800", "E-800 Pro"],
  ];
  for (const [left, right] of pairs) {
    const base = resolve(left);
    const variant = resolve(right);
    assert.equal(base.status, "resolved", left);
    assert.equal(variant.status, "resolved", right);
    assert.notEqual(base.normalizedModel, variant.normalizedModel, `${left} vs ${right}`);
  }
});

test("annotation removal never drops a revision token, even next to merchandising text", () => {
  const cases = [
    "D-1000 MK2 中古",
    "USED D-1000 MK2",
    "D-1000 USED MK2",
    "805 D4 Signature 【売約済】",
    "LS50 Meta 元箱付",
    "C1X (BK)",
  ];
  for (const input of cases) {
    const result = resolve(input);
    const before = normalizeIdentityModel(input);
    assert.ok(result.normalizedModel, input);
    // Nothing may be rewritten: the surviving identity is always a deletion of the original.
    assert.ok(before.includes(result.normalizedModel.slice(0, 4)), input);
  }
  assert.equal(resolve("805 D4 Signature 【売約済】").normalizedModel, "805D4SIGNATURE");
  assert.equal(resolve("LS50 Meta 元箱付").normalizedModel, "LS50META");
  assert.equal(resolve("C1X (BK)").normalizedModel, "C1X");
});

test("unclassifiable residue becomes a candidate instead of being deleted", () => {
  const japanese = resolve("E-800 特別価格キャンペーン");
  assert.equal(japanese.status, "candidate");
  assert.equal(japanese.method, "unsafe_annotation");
  assert.equal(japanese.confidence, "low");
  assert.deepEqual(japanese.unclassifiedTokens, ["unclassified_text"]);
  // Non-destructive: the token the resolver could not classify is still in the model.
  assert.equal(japanese.model, "E-800 特別価格キャンペーン");

  const inventoryNumber = resolve("E-800 123456");
  assert.equal(inventoryNumber.status, "candidate");
  assert.deepEqual(inventoryNumber.unclassifiedTokens, ["seller_number"]);
  assert.equal(inventoryNumber.model, "E-800 123456");

  const bracket = resolve("E-800 【特価】");
  assert.equal(bracket.status, "candidate");
  assert.ok(bracket.unclassifiedTokens.includes("seller_bracket"));
});

test("verified manufacturer presentation tokens are removed from the seller model", () => {
  const bootstrap = resolve("Accuphase E-800", "accuphase");
  assert.equal(bootstrap.model, "E-800");
  assert.equal(bootstrap.normalizedModel, "E800");

  const aliases: ManufacturerAliasEvidence[] = [
    {
      manufacturerId: "tad",
      canonicalName: "TAD",
      alias: "Technical Audio Devices",
      normalizedAlias: "technicalaudiodevices",
      verificationStatus: "verified",
      source: "manual_verified",
      ruleVersion: 2,
    },
  ];
  const operational = resolveModel(
    { rawModel: "Technical Audio Devices D-1000", manufacturerId: "tad" },
    aliases,
  );
  assert.equal(operational.model, "D-1000");
});

test("an unverified alias is not treated as a removable brand token", () => {
  const pending: ManufacturerAliasEvidence[] = [
    {
      manufacturerId: "tad",
      canonicalName: "TAD",
      alias: "Reference One",
      normalizedAlias: "referenceone",
      verificationStatus: "pending",
      source: "observed_listing",
      ruleVersion: 2,
    },
  ];
  const result = resolveModel({ rawModel: "Reference One D-1000", manufacturerId: "tad" }, pending);

  assert.equal(result.model, "Reference One D-1000");
});

test("title evidence is used only when the manufacturer resolved", () => {
  const resolved = resolveModel({
    rawModel: "",
    title: "Accuphase E-800 中古",
    manufacturerId: "accuphase",
  });
  assert.equal(resolved.model, "E-800");
  assert.equal(resolved.method, "title_after_manufacturer");
  assert.equal(resolved.confidence, "medium");
  assert.equal(resolved.rawModel, "");

  const unresolvedManufacturer = resolveModel({
    rawModel: "",
    title: "Accuphase E-800",
    manufacturerId: "",
  });
  assert.equal(unresolvedManufacturer.status, "unresolved");
  assert.equal(unresolvedManufacturer.method, "none");
});

test("a title tail that is still prose does not become a resolved model", () => {
  const prose = resolveModel({
    rawModel: "",
    title: "Accuphase Integrated Stereo Amplifier E-5000",
    manufacturerId: "accuphase",
  });
  assert.equal(prose.status, "candidate");
  assert.ok(prose.unclassifiedTokens.includes("title_prose"));
  // Non-destructive: the evidence is kept so a reviewer can see what the title actually said.
  assert.equal(prose.model, "Integrated Stereo Amplifier E-5000");

  const digitless = resolveModel({
    rawModel: "",
    title: "Accuphase Power Amplifier",
    manufacturerId: "accuphase",
  });
  assert.equal(digitless.status, "candidate");

  // Model-shaped tails still resolve from title evidence.
  for (const [title, expected] of [
    ["Accuphase E-800", "E-800"],
    ["TAD D-1000 MK2", "D-1000 MK2"],
    ["Bowers & Wilkins 805 D4 Signature", "805 D4 Signature"],
  ] as const) {
    const result = resolveModel({ rawModel: "", title, manufacturerId: "" });
    const withManufacturer = resolveModel({
      rawModel: "",
      title,
      manufacturerId: title.startsWith("TAD")
        ? "tad"
        : title.startsWith("Accuphase")
          ? "accuphase"
          : "bowers-wilkins",
    });
    assert.equal(result.status, "unresolved", title);
    assert.equal(withManufacturer.model, expected, title);
    assert.equal(withManufacturer.status, "resolved", title);
  }

  // A long seller-provided model field is still trusted; only title evidence is treated as prose.
  const sellerField = resolveModel({
    rawModel: "Integrated Stereo Amplifier E-5000",
    manufacturerId: "accuphase",
  });
  assert.equal(sellerField.status, "resolved");
});

test("a model with no alphanumeric identity stays unresolved and keeps its raw value", () => {
  const result = resolve("中古");

  assert.equal(result.status, "unresolved");
  assert.equal(result.normalizedModel, "");
  assert.equal(result.rawModel, "中古");
});

test("resolution is deterministic and repeatable for the same input", () => {
  const resolver = createModelResolver();
  const first = resolver({ rawModel: "D-1000 MK2 中古", manufacturerId: "tad" });
  const second = resolver({ rawModel: "D-1000 MK2 中古", manufacturerId: "tad" });

  assert.deepEqual(first, second);
});

test("annotation removal cannot turn a revision into a false catalog match", () => {
  const catalog = [
    { id: 1, manufacturerId: "tad", canonicalModel: "D-1000", aliases: [] },
    { id: 2, manufacturerId: "tad", canonicalModel: "D-1000 MK2", aliases: [] },
  ];

  // A cleaned annotation lets the correct revision match exactly...
  const cleaned = resolve("D-1000 MK2 中古美品");
  const matched = resolveProductIdentity({ manufacturerId: "tad", model: cleaned.model }, catalog);
  assert.equal(matched.status, "matched");
  assert.equal(matched.catalogProductId, 2);

  // ...while the base model still refuses to absorb the revision.
  const base = resolve("D-1000 中古美品");
  const baseMatch = resolveProductIdentity({ manufacturerId: "tad", model: base.model }, catalog);
  assert.equal(baseMatch.catalogProductId, 1);

  // A model the resolver could not fully classify must not attach at all. Identity normalization
  // erases the unclassified residue (`特別仕様` disappears), so without the status gate a special
  // edition would exact-match the base product at high confidence.
  const candidate = resolve("D-1000 MK2 特別仕様");
  assert.equal(candidate.status, "candidate");
  assert.equal(normalizeIdentityModel(candidate.model), "D1000MK2");
  const gated = resolveProductIdentity(
    { manufacturerId: "tad", model: candidate.model, modelResolutionStatus: candidate.status },
    catalog,
  );
  assert.equal(gated.status, "unresolved");
  assert.equal(gated.catalogProductId, null);
  assert.deepEqual(gated.rejectedBy, ["unresolved_model"]);
});

test("applying resolution records replayable metadata without touching seller evidence", () => {
  const product = {
    sourceId: "p1",
    manufacturer: "TAD",
    rawManufacturer: "TAD",
    manufacturerId: "tad",
    model: "D-1000 MK2 中古",
    rawModel: "D-1000 MK2 中古",
    normalizedModel: "",
    title: "TAD D-1000 MK2 中古",
    metadata: { keep: true },
  } as unknown as NormalizedCatalogProduct;

  const applied = applyModelResolution(product);

  assert.equal(applied.rawModel, "D-1000 MK2 中古");
  assert.equal(applied.model, "D-1000 MK2");
  assert.equal(applied.normalizedModel, "D1000MK2");
  assert.equal(applied.modelResolutionStatus, "resolved");
  assert.equal(applied.modelResolutionMethod, "seller_model_annotated");
  assert.deepEqual(applied.metadata.modelNormalization, {
    version: MODEL_RESOLVER_VERSION,
    status: "resolved",
    method: "seller_model_annotated",
    confidence: "high",
    normalizedModel: "D1000MK2",
    removedAnnotations: ["condition"],
    unclassifiedTokens: [],
  });
  assert.equal(applied.metadata.keep, true);
});
