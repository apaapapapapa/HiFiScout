import assert from "node:assert/strict";
import test from "node:test";

import { resolveModel } from "../src/catalog/model-resolver.js";
import { splitManufacturerModel } from "../src/crawler/normalize.js";

/**
 * The Model Resolver against the shapes each shop adapter actually produces.
 *
 * `model-resolver.test.ts` proves the rules with synthetic inputs. That is the right place to state
 * a rule, but it cannot notice that the seven adapters hand the resolver seven different *kinds* of
 * string: Hifido and For Music pass the list title through as the model, Shimamusen and Ippinkan
 * split it first, U-Audio strips its own seller-note suffix before the resolver ever sees it, Audio
 * Union emits a dedicated model field, and Fujiya-Avic leaves its stock code attached. A rule that
 * is correct in the abstract can still be wrong for one of those shapes.
 *
 * Where an adapter derives the model from the title, the fixture derives it the same way — through
 * `splitManufacturerModel` — so a change to that split shows up here instead of silently making
 * these cases describe input no shop sends any more.
 */

interface ShopModelCase {
  /** Which adapter's shape this is. */
  readonly shopKey: string;
  /** The seller title as the adapter reads it. */
  readonly title: string;
  /**
   * What the adapter puts in `model`, which becomes `rawModel`. Omitted when the adapter derives it
   * from the title with {@link splitManufacturerModel}.
   */
  readonly rawModel?: string;
  readonly manufacturerId: string;
  readonly expected: {
    readonly model: string;
    readonly normalizedModel: string;
    readonly status: string;
    readonly method: string;
    readonly removedAnnotations: readonly string[];
    readonly unclassifiedTokens?: readonly string[];
  };
}

const SHOP_CASES: readonly ShopModelCase[] = [
  // Hifido passes the list-title anchor straight through, so the model is already bare.
  {
    shopKey: "hifido",
    title: "MC240",
    rawModel: "MC240",
    manufacturerId: "mcintosh",
    expected: {
      model: "MC240",
      normalizedModel: "MC240",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  // A slash-separated revision is identity, not punctuation to be tidied away.
  {
    shopKey: "hifido",
    title: "MC275/MK6",
    rawModel: "MC275/MK6",
    manufacturerId: "mcintosh",
    expected: {
      model: "MC275/MK6",
      normalizedModel: "MC275MK6",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  {
    shopKey: "hifido",
    title: "MC275/MK6 【売約済】",
    rawModel: "MC275/MK6 【売約済】",
    manufacturerId: "mcintosh",
    expected: {
      model: "MC275/MK6",
      normalizedModel: "MC275MK6",
      status: "resolved",
      method: "seller_model_annotated",
      removedAnnotations: ["listing_state"],
    },
  },
  // For Music also uses the title as the model; `X` here is an edition, not a stray letter.
  {
    shopKey: "formusic",
    title: "C-10X",
    rawModel: "C-10X",
    manufacturerId: "luxman",
    expected: {
      model: "C-10X",
      normalizedModel: "C10X",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  {
    shopKey: "formusic",
    title: "LS50 Meta / ブラック",
    rawModel: "LS50 Meta / ブラック",
    manufacturerId: "kef",
    expected: {
      model: "LS50 Meta",
      normalizedModel: "LS50META",
      status: "resolved",
      method: "seller_model_annotated",
      removedAnnotations: ["presentation_color"],
    },
  },
  // Shimamusen titles carry a 〖…〗 condition marker and a trailing Japanese product-type word.
  // Section 5 treats only the terminal product-type vocabulary as non-identity annotation; edition
  // tokens such as SE remain part of the resolved model.
  {
    shopKey: "shimamusen",
    title: "〖展示処分品〗ESOTERIC N-01XD SE ネットワークプレーヤー",
    manufacturerId: "esoteric",
    expected: {
      model: "N-01XD SE",
      normalizedModel: "N01XDSE",
      status: "resolved",
      method: "seller_model_annotated",
      removedAnnotations: ["product_type_suffix"],
    },
  },
  {
    shopKey: "shimamusen",
    title: "〖B級品〗ACCUPHASE E-800",
    manufacturerId: "accuphase",
    expected: {
      model: "E-800",
      normalizedModel: "E800",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  // U-Audio writes `model / manufacturer` and strips its own note suffix, so the resolver receives
  // an already-clean model. Asserting it stays clean is what proves the two layers do not fight.
  {
    shopKey: "u-audio",
    title: "E-800 ※商談中 / アキュフェーズ",
    rawModel: "E-800",
    manufacturerId: "accuphase",
    expected: {
      model: "E-800",
      normalizedModel: "E800",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  {
    shopKey: "u-audio",
    title: "805 D4 Signature 展示処分品 / B&W",
    rawModel: "805 D4 Signature",
    manufacturerId: "bowers-wilkins",
    expected: {
      model: "805 D4 Signature",
      normalizedModel: "805D4SIGNATURE",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  // Audio Union emits a dedicated model field. `No.326S` and a two-part turntable/arm model are the
  // shapes that punctuation-stripping normalization could quietly damage.
  {
    shopKey: "audiounion",
    title: "マークレビンソン No.326S",
    rawModel: "No.326S",
    manufacturerId: "mark-levinson",
    expected: {
      model: "No.326S",
      normalizedModel: "NO326S",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  {
    shopKey: "audiounion",
    title: "トーレンス TD520RW 3012R",
    rawModel: "TD520RW 3012R",
    manufacturerId: "thorens",
    expected: {
      model: "TD520RW 3012R",
      normalizedModel: "TD520RW3012R",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  {
    shopKey: "audiounion",
    title: "ラックスマン L-507Z 元箱付",
    rawModel: "L-507Z 元箱付",
    manufacturerId: "luxman",
    expected: {
      model: "L-507Z",
      normalizedModel: "L507Z",
      status: "resolved",
      method: "seller_model_annotated",
      removedAnnotations: ["packaging"],
    },
  },
  // Fujiya-Avic keeps colour and variant letters inside the model number itself — `/B` and `-K` are
  // part of what the maker calls the product, so neither may be treated as a presentation suffix.
  {
    shopKey: "fujiya-avic",
    title: "FOSTEX FS-700S3/B スピーカー",
    rawModel: "FS-700S3/B",
    manufacturerId: "fostex",
    expected: {
      model: "FS-700S3/B",
      normalizedModel: "FS700S3B",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  {
    shopKey: "fujiya-avic",
    title: "DENON DP-200USB-K レコードプレーヤー",
    rawModel: "DP-200USB-K",
    manufacturerId: "denon",
    expected: {
      model: "DP-200USB-K",
      normalizedModel: "DP200USBK",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  // ...but its bracketed stock code is the shop's, not the maker's.
  {
    shopKey: "fujiya-avic",
    title: "NUARL N7 [SPK-A003]",
    rawModel: "N7 [SPK-A003]",
    manufacturerId: "nuarl",
    expected: {
      model: "N7",
      normalizedModel: "N7",
      status: "resolved",
      method: "seller_model_annotated",
      removedAnnotations: ["seller_sku"],
    },
  },
  {
    shopKey: "fujiya-avic",
    title: "MARANTZ SA-10 SE 管理番号:AB1234",
    rawModel: "SA-10 SE 管理番号:AB1234",
    manufacturerId: "marantz",
    expected: {
      model: "SA-10 SE",
      normalizedModel: "SA10SE",
      status: "resolved",
      method: "seller_model_annotated",
      removedAnnotations: ["seller_sku"],
    },
  },
  // Ippinkan separates manufacturer and model with " - ", leaving condition text on the model side.
  {
    shopKey: "ippinkan",
    title: "ACCUPHASE - E-800",
    manufacturerId: "accuphase",
    expected: {
      model: "E-800",
      normalizedModel: "E800",
      status: "resolved",
      method: "seller_model",
      removedAnnotations: [],
    },
  },
  {
    shopKey: "ippinkan",
    title: "LUXMAN - L-507Z 中古美品",
    manufacturerId: "luxman",
    expected: {
      model: "L-507Z",
      normalizedModel: "L507Z",
      status: "resolved",
      method: "seller_model_annotated",
      removedAnnotations: ["condition"],
    },
  },
  {
    shopKey: "ippinkan",
    title: "TAD - D1000MK2 展示品",
    manufacturerId: "tad",
    expected: {
      model: "D1000MK2",
      normalizedModel: "D1000MK2",
      status: "resolved",
      method: "seller_model_annotated",
      removedAnnotations: ["condition"],
    },
  },
];

function rawModelFor(shopCase: ShopModelCase): string {
  return shopCase.rawModel ?? splitManufacturerModel(shopCase.title, shopCase.shopKey).model;
}

for (const shopCase of SHOP_CASES) {
  const rawModel = rawModelFor(shopCase);
  test(`${shopCase.shopKey} resolves ${JSON.stringify(rawModel)} without inventing identity`, () => {
    const result = resolveModel({
      rawModel,
      title: shopCase.title,
      manufacturerId: shopCase.manufacturerId,
    });

    assert.equal(result.model, shopCase.expected.model);
    assert.equal(result.normalizedModel, shopCase.expected.normalizedModel);
    assert.equal(result.status, shopCase.expected.status);
    assert.equal(result.method, shopCase.expected.method);
    assert.deepEqual(result.removedAnnotations, [...shopCase.expected.removedAnnotations]);
    assert.deepEqual(result.unclassifiedTokens, [...(shopCase.expected.unclassifiedTokens ?? [])]);
    // Seller evidence is immutable no matter which shop shape produced it.
    assert.equal(result.rawModel, rawModel);
  });
}

test("no two shops' spellings of one product resolve to different identities", () => {
  // The same Accuphase E-800 as Ippinkan, U-Audio and Shimamusen each write it.
  const spellings = [
    { shopKey: "ippinkan", title: "ACCUPHASE - E-800", rawModel: "" },
    { shopKey: "u-audio", title: "E-800 ※商談中 / アキュフェーズ", rawModel: "E-800" },
    { shopKey: "shimamusen", title: "〖B級品〗ACCUPHASE E-800", rawModel: "" },
  ];
  const normalized = new Set(
    spellings.map(
      (spelling) =>
        resolveModel({
          rawModel:
            spelling.rawModel || splitManufacturerModel(spelling.title, spelling.shopKey).model,
          title: spelling.title,
          manufacturerId: "accuphase",
        }).normalizedModel,
    ),
  );

  assert.deepEqual([...normalized], ["E800"]);
});

test("a terminal product-type word is removed without erasing the model revision", () => {
  const shimamusen = resolveModel({
    rawModel: splitManufacturerModel(
      "〖展示処分品〗ESOTERIC N-01XD SE ネットワークプレーヤー",
      "shimamusen",
    ).model,
    title: "〖展示処分品〗ESOTERIC N-01XD SE ネットワークプレーヤー",
    manufacturerId: "esoteric",
  });

  assert.equal(shimamusen.status, "resolved");
  assert.equal(shimamusen.model, "N-01XD SE");
  assert.deepEqual(shimamusen.removedAnnotations, ["product_type_suffix"]);
  // The revision remains in identity, so this cannot attach to the base N-01XD.
  assert.equal(shimamusen.normalizedModel, "N01XDSE");
});
