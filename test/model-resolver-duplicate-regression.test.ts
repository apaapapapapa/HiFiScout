import assert from "node:assert/strict";
import { test } from "vitest";

import { resolveModel } from "../src/catalog/model-resolver.js";
import { normalizeIdentityModel } from "../src/catalog/product-identity.js";

function resolve(rawModel: string, manufacturerId = "ediscreation") {
  return resolveModel({ rawModel, manufacturerId });
}

test("seller product-type suffixes do not split the same model across shops", () => {
  const fiberBox = resolve("Fiber Box 2 JPSM 光絶縁ツール エディスクリエーション");
  assert.equal(fiberBox.status, "resolved");
  assert.equal(fiberBox.model, "Fiber Box 2 JPSM");
  assert.equal(fiberBox.normalizedModel, "FIBERBOX2JPSM");
  assert.deepEqual(fiberBox.removedAnnotations, ["seller_title_suffix"]);

  const accuphase = resolveModel({
    rawModel: "DP-570 CDデッキ アキュフェーズ",
    manufacturerId: "accuphase",
  });
  assert.equal(accuphase.status, "resolved");
  assert.equal(accuphase.model, "DP-570");
  assert.equal(accuphase.normalizedModel, "DP570");
});

test("a retailer long-form model may converge on its strongly overlapping bracketed market alias", () => {
  const result = resolve("SilentSwitch OCXO JPN STD [SILENT SWITCH OCXO JPSM]");

  assert.equal(result.status, "resolved");
  assert.equal(result.model, "SILENT SWITCH OCXO JPSM");
  assert.equal(result.normalizedModel, "SILENTSWITCHOCXOJPSM");
  assert.deepEqual(result.removedAnnotations, ["seller_model_alias"]);
});

test("brackets and unknown Japanese residue remain conservative when identity evidence is weak", () => {
  const unrelatedBracket = resolve("Model 1000 Standard [LIMITED EDITION]");
  assert.equal(unrelatedBracket.status, "candidate");
  assert.equal(unrelatedBracket.model, "Model 1000 Standard [LIMITED EDITION]");
  assert.ok(unrelatedBracket.unclassifiedTokens.includes("seller_bracket"));

  const specialEdition = resolve("D-1000 MK2 特別仕様", "tad");
  assert.equal(specialEdition.status, "candidate");
  assert.equal(normalizeIdentityModel(specialEdition.model), "D1000MK2");
});
