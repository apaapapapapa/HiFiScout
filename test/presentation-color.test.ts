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
 * The finish is presentation, not identity.
 *
 * Two colours of one product must stay one card — that is what the model resolver's colour removal
 * has always been for — while the finish the seller named still reaches the shopper. These tests
 * hold both halves: the model never gains the finish back, and the finish is never lost.
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
  // A qualified finish is its own thing to look at, not a synonym for the plain one.
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
  assert.equal(presentationColorLabel(["ブラック", "ゴールド"]), "ブラック/ゴールド");
  assert.equal(presentationColorLabel([]), "");
});

test("a product lists the finishes its offers are in, without inventing any", () => {
  assert.deepEqual(presentationColorList(["シルバー", "ブラック", "シルバー"]), [
    "ブラック",
    "シルバー",
  ]);
  // A two-tone offer is one finish to buy; splitting it would advertise a plain gold nobody listed.
  assert.deepEqual(presentationColorList(["ブラック/ゴールド"]), ["ブラック/ゴールド"]);
  assert.deepEqual(presentationColorList(["", "ラッカー塗装"]), []);
});

test("the finish leaves the model and is reported beside it", () => {
  const cases: [string, string, string, string][] = [
    ["802D4 B グロス・ブラック(ペア)", "bowers-wilkins", "802D4 B", "グロスブラック"],
    ["MC Cadenza Black", "ortofon", "MC Cadenza", "ブラック"],
    ["LS-R0 BLACK", "orb", "LS-R0", "ブラック"],
    ["A25 [ブラック]", "arcam", "A25", "ブラック"],
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
    // The finish must not survive in identity, or the colours stop grouping.
    assert.ok(!result.normalizedModel.includes("BLACK"), rawModel);
  }
});

test("a finish still sitting in the model is not also reported beside it", () => {
  // `FS-700S3/B` is a model, not a finish code: the colour rules reject it, so nothing is claimed.
  const compact = resolveModel({ rawModel: "FS-700S3/B", title: "", manufacturerId: "luxman" });
  assert.equal(compact.model, "FS-700S3/B");
  assert.deepEqual(compact.presentationColors, []);
});

test("one product, several finishes, one card", () => {
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

  // Same identity, so both listings aggregate into one entity …
  assert.equal(black.normalizedModel, bronze.normalizedModel);
  assert.equal(black.model, "MC Cadenza");
  assert.equal(bronze.model, "MC Cadenza");
  // … and only the finish tells them apart.
  assert.equal(black.presentationColor, "ブラック");
  assert.equal(bronze.presentationColor, "ブロンズ");

  const card = toProductSearchItem(
    entityRow({ model: "MC Cadenza", presentation_colors: "シルバー,ブラック" }),
  );
  assert.deepEqual(card.presentation_colors, ["ブラック", "シルバー"]);
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
