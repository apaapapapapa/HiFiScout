import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { visibleFacetOptions } from "../frontend/facet-options.js";
import { CATEGORIES } from "../src/catalog/categories.js";
import type { FacetSelection, MetaResponse } from "../src/api/contracts.js";

const meta: MetaResponse = {
  status: "healthy",
  shops: [],
  manufacturers: [],
  categories: [],
  categoryFacets: CATEGORIES.map((category) => ({
    ...category,
    group: category.parentId,
    activeProductCount: 0,
  })),
  legacyCategoryAliases: { speaker_bookshelf: ["SPK.LOUDSPEAKER"] },
};

function values(category: string, id: string, selected: FacetSelection[] = []) {
  return (
    visibleFacetOptions(category, selected, meta)
      .find((facet) => facet.id === id)
      ?.values.map((value) => value.id) ?? []
  );
}

test("speaker and personal audio choices are scoped down to each value", () => {
  assert.deepEqual(values("SPK.LOUDSPEAKER", "form_factor"), [
    "bookshelf",
    "floorstanding",
    "desktop",
    "one_box",
  ]);
  assert.deepEqual(values("PER.HEADPHONE", "form_factor"), ["over_ear", "on_ear", "open_ear"]);
  assert.deepEqual(values("PER.EARPHONE", "form_factor"), ["true_wireless", "in_ear", "open_ear"]);
  assert.deepEqual(values("SPK.SUBWOOFER", "form_factor"), []);
  assert.deepEqual(
    values("speaker_bookshelf", "form_factor"),
    values("SPK.LOUDSPEAKER", "form_factor"),
  );
});

test("parent categories reveal the union of applicable child choices", () => {
  assert.deepEqual(values("PER", "form_factor"), [
    "true_wireless",
    "over_ear",
    "on_ear",
    "in_ear",
    "open_ear",
  ]);
  assert.equal(values("SRC", "supported_media").length, 10);
  assert.deepEqual(values("ANA", "supported_media"), []);
});

test("tape ancestry comes from the registry, and media are split by equipment", () => {
  assert.deepEqual(values("ANA.TAPE", "supported_media"), ["cassette", "open_reel", "dat", "dcc"]);
  assert.deepEqual(values("SRC.DISC", "supported_media"), [
    "cd",
    "sacd",
    "dvd",
    "blu_ray",
    "md",
    "ld",
  ]);
  assert.deepEqual(values("SRC.TUNER", "supported_media"), []);
});

test("specialist fields appear only for relevant leaves", () => {
  assert.ok(values("AMP.HEADPHONE", "portability").includes("portable"));
  assert.deepEqual(values("AMP.POWER", "portability"), []);
  assert.ok(values("AMP.PHONO", "phono_support").includes("mc"));
  assert.deepEqual(values("AMP.POWER", "phono_support"), []);
  assert.deepEqual(values("AMP.INTEGRATED", "technology"), ["tube", "solid_state", "class_d"]);
  assert.deepEqual(values("ANA.TONEARM", "cartridge_type"), []);
  assert.deepEqual(values("PRC.DAC", "processor_type"), []);
  assert.deepEqual(values("PWR.DISTRIBUTION", "cable_length"), []);
  assert.ok(values("PWR.CORD", "cable_length").length > 0);
  assert.deepEqual(values("ACC.STAND", "part_type"), []);
});

test("selected incompatible values remain removable without revealing unrelated siblings", () => {
  const selected: FacetSelection[] = [
    { facetId: "form_factor", value: "bookshelf" },
    { facetId: "cartridge_type", value: "mc" },
  ];
  assert.deepEqual(values("PER.HEADPHONE", "form_factor", selected), [
    "bookshelf",
    "over_ear",
    "on_ear",
    "open_ear",
  ]);
  assert.deepEqual(values("PER.HEADPHONE", "cartridge_type", selected), ["mc"]);
  assert.deepEqual(values("", "form_factor", selected), ["bookshelf"]);
  assert.deepEqual(
    visibleFacetOptions("", selected, null)
      .find((facet) => facet.id === "cartridge_type")
      ?.values.map((value) => value.id),
    ["mc"],
  );
  assert.equal(selected.length, 2);
});

test("unselected category shows only global fields, including when metadata is missing", () => {
  assert.deepEqual(
    visibleFacetOptions("", [], null).map((facet) => facet.id),
    ["use_case"],
  );
  assert.deepEqual(
    visibleFacetOptions("unclassified", [], meta).map((facet) => facet.id),
    ["use_case"],
  );
});
