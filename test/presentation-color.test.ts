import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  normalizePresentationColor,
  presentationColorLabel,
  presentationColorLabels,
  presentationColorList,
} from "../src/catalog/model-presentation-color.js";
import { resolveModel } from "../src/catalog/model-resolver.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { toProductSearchItem } from "../src/db/product-search-entity-mapper.js";
import { entityRow } from "./helpers/product-search.js";

/**
 * A color word is not sufficient evidence that text is presentation rather than identity.
 *
 * Audio manufacturers use color words as model/grade names (Ortofon Cadenza/2M are canonical
 * examples), while retailers also append actual finishes to otherwise identical products. These
 * tests hold the conservative boundary: ambiguous bare colors stay in identity; explicit seller
 * presentation syntax may move the finish beside the model.
 */

test("every spelling of one finish normalizes to a single label", () => {
  const spellings: [string, string][] = [
    ["ブラック", "ブラック"],
    ["BLACK", "ブラック"],
    ["Black", "ブラック"],
    ["黒", "ブラック"],
    ["BK", "ブラック"],
    ["blk", "ブラック"],
    ["グロス・ブラック", "グロスブラック"],
    ["グロスブラック", "グロスブラック"],
    ["GLOSS BLACK", "グロスブラック"],
    ["シルバー", "シルバー"],
    ["silver", "シルバー"],
    ["SLV", "シルバー"],
    ["ウォルナット", "ウォールナット"],
    ["walnut", "ウォールナット"],
  ];
  for (const [spelling, expected] of spellings) {
    assert.equal(normalizePresentationColor(spelling)?.name, expected, spelling);
  }
  assert.notEqual(
    normalizePresentationColor("グロスブラック")?.id,
    normalizePresentationColor("ブラック")?.id,
  );
  assert.equal(normalizePresentationColor("ラッカー塗装"), null);
});

test("labels are catalog-ordered and a two-tone finish stays one label", () => {
  assert.deepEqual(presentationColorLabels(["silver", "BLACK", "ブラック"]), [
    "ブラック",
    "シルバー",
  ]);
  assert.equal(presentationColorLabel(["ブラック/ゴールド"]), "ブラック/ゴールド");
  assert.equal(presentationColorLabel(["ブラック", "ゴールド"]), "ブラック/ゴールド");
  assert.equal(presentationColorLabel([]), "");
});

test("a product lists the finishes its offers are in, without inventing any", () => {
  assert.deepEqual(presentationColorList(["シルバー", "ブラック", "シルバー"]), [
    "ブラック",
    "シルバー",
  ]);
  assert.deepEqual(presentationColorList(["ブラック/ゴールド"]), ["ブラック/ゴールド"]);
  assert.deepEqual(presentationColorList(["", "ラッカー塗装"]), []);
});

test("explicit seller presentation syntax moves the finish beside the model", () => {
  const cases: [string, string, string, string][] = [
    ["802D4 B グロス・ブラック(ペア)", "bowers-wilkins", "802D4 B", "グロスブラック"],
    ["A25 [ブラック]", "arcam", "A25", "ブラック"],
    ["A25 COLOR: BLACK", "arcam", "A25", "ブラック"],
    ["A25 BLACK FINISH", "arcam", "A25", "ブラック"],
    ["A25 - BLACK", "arcam", "A25", "ブラック"],
    [
      "91E ブラック/ゴールド 真空管プリメインアンプ",
      "western-electric",
      "91E",
      "ブラック/ゴールド",
    ],
    ["L-507Z", "luxman", "L-507Z", ""],
  ];
  for (const [rawModel, manufacturerId, model, color] of cases) {
    const result = resolveModel({ rawModel, title: "", manufacturerId });
    assert.equal(result.model, model, rawModel);
    assert.equal(presentationColorLabel(result.presentationColors), color, rawModel);
  }
});

test("ambiguous bare color words remain identity-bearing", () => {
  const models = [
    ["MC Cadenza Black", "ortofon"],
    ["MC Cadenza Bronze", "ortofon"],
    ["MC Cadenza Blue", "ortofon"],
    ["MC Cadenza Red", "ortofon"],
    ["2M Black", "ortofon"],
    ["2M Bronze", "ortofon"],
    ["2M Blue", "ortofon"],
    ["2M Red", "ortofon"],
    // Transliteration does not turn the Black cartridge into a presentation finish.
    ["MC Cadenza ブラック", "ortofon"],
    // Monitor Red is a Tannoy driver generation, not the cabinet's paint colour.
    ["Rectangular GRF 15′′Monitor Red", "tannoy"],
    ["Rectangular GRF 15′′Monitor レッド", "tannoy"],
    // This is a real finish in seller data, but bare BLACK alone is not enough evidence to remove
    // it safely without verified product-finish knowledge. Prefer a temporary split to a false merge.
    ["LS-R0 BLACK", "orb"],
  ] as const;

  for (const [rawModel, manufacturerId] of models) {
    const result = resolveModel({ rawModel, title: "", manufacturerId });
    assert.equal(result.model, rawModel, rawModel);
    assert.deepEqual(result.presentationColors, [], rawModel);
  }
});

test("verified product lines may use a bare English presentation colour", () => {
  const cases: [string, string, string][] = [
    ["D-1000 BLACK", "D-1000", "ブラック"],
    ["D-1000 MK2 SILVER", "D-1000 MK2", "シルバー"],
    ["D-1000TX Walnut", "D-1000TX", "ウォールナット"],
  ];

  for (const [rawModel, model, color] of cases) {
    const result = resolveModel({ rawModel, title: "", manufacturerId: "tad" });
    assert.equal(result.model, model, rawModel);
    assert.equal(presentationColorLabel(result.presentationColors), color, rawModel);
  }
});

test("explicit finish syntax does not erase a color-bearing model name", () => {
  const result = resolveModel({
    rawModel: "MC Cadenza Black [ブラック]",
    title: "",
    manufacturerId: "ortofon",
  });
  assert.equal(result.model, "MC Cadenza Black");
  assert.equal(presentationColorLabel(result.presentationColors), "ブラック");
});

test("compact model suffixes remain identity-bearing", () => {
  const compact = resolveModel({ rawModel: "FS-700S3/B", title: "", manufacturerId: "luxman" });
  assert.equal(compact.model, "FS-700S3/B");
  assert.deepEqual(compact.presentationColors, []);
});

test("color-bearing Ortofon models remain separate product identities", () => {
  const black = normalizeCatalogProduct({
    sourceId: "1",
    manufacturer: "ortofon",
    model: "MC Cadenza Black",
    title: "ortofon MC Cadenza Black",
    conditionText: "中古",
    priceYen: 200_000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/1",
  });
  const bronze = normalizeCatalogProduct({
    sourceId: "2",
    manufacturer: "ortofon",
    model: "MC Cadenza Bronze",
    title: "ortofon MC Cadenza Bronze",
    conditionText: "中古",
    priceYen: 210_000,
    stockStatus: "in_stock",
    sourceUrl: "https://example.test/2",
  });

  assert.equal(black.model, "MC Cadenza Black");
  assert.equal(bronze.model, "MC Cadenza Bronze");
  assert.notEqual(black.normalizedModel, bronze.normalizedModel);
  assert.equal(black.presentationColor, "");
  assert.equal(bronze.presentationColor, "");
});

test("a card shows the finishes of the offers that matched its filters", () => {
  const filtered = toProductSearchItem(entityRow({ presentation_colors: "ブラック,シルバー" }), {
    aggregate: {
      entity_id: 1,
      presentation_colors: "シルバー",
      offer_count: 1,
      in_stock_offer_count: 1,
      sold_out_offer_count: 0,
      shop_count: 1,
      lowest_price_yen: 300_000,
      highest_price_yen: 300_000,
      latest_activity_at: null,
      newest_listed_at: null,
      has_price_drop: 0,
    },
  });

  assert.deepEqual(filtered.presentation_colors, ["シルバー"]);
});
