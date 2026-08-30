import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  CATEGORIES,
  LEGACY_CATEGORY_MIGRATION_RULES,
  TAXONOMY_VERSION,
  categoryClosureIds,
  categoryIdForClassification,
  categoryIdForFilter,
  getCategory,
} from "../src/catalog/categories.js";
import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { parsedProduct } from "./helpers/fixtures.js";

const roots = () => CATEGORIES.filter((category) => category.parentId == null);
const children = (parentId: string) =>
  CATEGORIES.filter((category) => category.parentId === parentId);

function classify(title: string) {
  return normalizeCatalogProduct(
    parsedProduct({
      manufacturer: "",
      rawManufacturer: "",
      title,
      category: "",
      rawCategory: "",
    }),
    { categoryPolicy: { parserHint: "ignore", sellerCategory: { default: "corroborative" } } },
  );
}

test("taxonomy v3 has the specified product-type roots in stable order", () => {
  assert.equal(TAXONOMY_VERSION, "v3");
  assert.deepEqual(
    roots().map((category) => category.id),
    [
      "PER",
      "SPK",
      "AMP",
      "SRC",
      "ANA",
      "PRC",
      "SIG",
      "CAB",
      "PWR",
      "ACC",
      "SYS",
      "REC",
      "unclassified",
    ],
  );
  assert.ok(
    roots()
      .slice(0, -1)
      .every((category) => category.filterable && !category.classifiable),
  );
  assert.deepEqual(
    [getCategory("unclassified")?.filterable, getCategory("unclassified")?.classifiable],
    [false, false],
  );
});

test("taxonomy v3 keeps product types in categories and properties out of them", () => {
  assert.deepEqual(
    children("PER").map((category) => category.id),
    ["PER.HEADPHONE", "PER.EARPHONE"],
  );
  assert.deepEqual(
    children("SPK").map((category) => category.id),
    ["SPK.LOUDSPEAKER", "SPK.SUBWOOFER", "SPK.SOUNDBAR"],
  );
  assert.deepEqual(
    children("CAB").map((category) => category.id),
    ["CAB.ANALOG", "CAB.DIGITAL", "CAB.SPEAKER", "CAB.PERSONAL", "CAB.DATA", "CAB.ADAPTER"],
  );
  const ids = new Set(CATEGORIES.map((category) => category.id));
  for (const propertyCategory of [
    "wired_headphone",
    "btw_earphone",
    "speaker_bookshelf",
    "active_speaker",
    "cable_xlr",
  ]) {
    assert.equal(ids.has(propertyCategory as never), false);
  }
});

test("all 59 legacy ids have explicit migration rules and none is canonical", () => {
  assert.equal(LEGACY_CATEGORY_MIGRATION_RULES.length, 59);
  assert.equal(new Set(LEGACY_CATEGORY_MIGRATION_RULES.map((rule) => rule.legacyId)).size, 59);
  const canonicalIds = new Set(CATEGORIES.map((category) => String(category.id)));
  for (const rule of LEGACY_CATEGORY_MIGRATION_RULES) {
    assert.ok(rule.categoryIds.length > 0, rule.legacyId);
    assert.equal(canonicalIds.has(rule.legacyId), false, rule.legacyId);
    assert.ok(
      rule.categoryIds.every((categoryId) => canonicalIds.has(categoryId)),
      rule.legacyId,
    );
  }
  assert.equal(categoryIdForClassification("network_transport"), "SRC.STREAMER");
  assert.equal(categoryIdForClassification("cd_sacd_transport"), "SRC.DISC");
  assert.equal(categoryIdForFilter("speaker_bookshelf"), "SPK.LOUDSPEAKER");
  assert.equal(categoryIdForClassification("cable_xlr", "XLR cable"), null);
  assert.equal(
    categoryIdForClassification("cable_xlr", "AES/EBU XLR digital cable"),
    "CAB.DIGITAL",
  );
});

test("canonical closure contains one leaf and its product-type root", () => {
  assert.deepEqual(categoryClosureIds("AMP.PRE"), ["AMP.PRE", "AMP"]);
  assert.deepEqual(categoryClosureIds("SRC.DISC"), ["SRC.DISC", "SRC"]);
  assert.deepEqual(categoryClosureIds("CAB.ANALOG"), ["CAB.ANALOG", "CAB"]);
});

test("headphone and speaker properties become independent facets", () => {
  const headphone = classify("Bluetooth wireless headphones with detachable wired USB cable");
  assert.equal(headphone.primaryCategoryId, "PER.HEADPHONE");
  assert.ok(
    headphone.facetFacts.some(
      (fact) => fact.facetId === "connectivity" && fact.value === "wireless",
    ),
  );
  assert.ok(
    headphone.facetFacts.some((fact) => fact.facetId === "connectivity" && fact.value === "wired"),
  );
  assert.ok(
    headphone.facetFacts.some((fact) => fact.facetId === "protocol" && fact.value === "bluetooth"),
  );

  const speaker = classify("Active bookshelf speaker for desktop studio use");
  assert.equal(speaker.primaryCategoryId, "SPK.LOUDSPEAKER");
  assert.ok(
    speaker.facetFacts.some((fact) => fact.facetId === "form_factor" && fact.value === "bookshelf"),
  );
  assert.ok(
    speaker.facetFacts.some(
      (fact) => fact.facetId === "amplification_mode" && fact.value === "active",
    ),
  );
  assert.ok(
    speaker.facetFacts.some((fact) => fact.facetId === "use_case" && fact.value === "studio"),
  );
});

test("XLR and transports use product type plus signal/connector facets", () => {
  const analog = classify("XLR analog interconnect cable 1m");
  assert.equal(analog.primaryCategoryId, "CAB.ANALOG");
  assert.ok(
    analog.facetFacts.some((fact) => fact.facetId === "connector_a" && fact.value === "xlr"),
  );
  assert.ok(
    analog.facetFacts.some((fact) => fact.facetId === "signal_type" && fact.value === "analog"),
  );

  const digital = classify("AES/EBU XLR digital cable 1m");
  assert.equal(digital.primaryCategoryId, "CAB.DIGITAL");
  assert.ok(
    digital.facetFacts.some((fact) => fact.facetId === "signal_type" && fact.value === "digital"),
  );

  assert.deepEqual(inferExplicitCategoryIds("Network Transport N1"), ["SRC.STREAMER"]);
  assert.deepEqual(inferExplicitCategoryIds("SACD Transport P1"), ["SRC.DISC"]);
  assert.deepEqual(inferExplicitCategoryIds("USB Digital Bridge U1"), ["PRC.DDC"]);
});

test("hybrid products keep their conventional type and capabilities", () => {
  const product = classify("Network Streamer with built-in DAC and headphone output");
  assert.equal(product.primaryCategoryId, "SRC.STREAMER");
  assert.equal(product.featureFacts.find((fact) => fact.featureId === "dac")?.state, "present");
  assert.equal(
    product.featureFacts.find((fact) => fact.featureId === "headphone_output")?.state,
    "present",
  );
});

test("multifunction classification is strict and conventional products win", () => {
  assert.equal(
    classify("All-in-one DAC headphone amp network playback preamp").primaryCategoryId,
    "SYS.MULTIFUNCTION",
  );
  assert.equal(
    classify("All-in-one integrated amplifier with DAC streaming and headphone amp")
      .primaryCategoryId,
    "AMP.INTEGRATED",
  );
  assert.equal(
    classify("Integrated amplifier with DAC and streamer").primaryCategoryId,
    "AMP.INTEGRATED",
  );
});

test("unknown and legacy other never become a normal catch-all category", () => {
  assert.equal(classify("Mystery audio widget Z9").primaryCategoryId, "unclassified");
  assert.equal(categoryIdForClassification("other", "Mystery audio widget Z9"), null);
  assert.equal(categoryIdForClassification("other", "FM stereo tuner T1"), "SRC.TUNER");
  assert.equal(
    CATEGORIES.some((category) => category.id === ("other" as never)),
    false,
  );
});
