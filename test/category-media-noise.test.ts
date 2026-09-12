import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { categoryClosureIds, categoryFilterIds, getCategory } from "../src/catalog/categories.js";
import { classifyCategoryEvidence } from "../src/catalog/category-classifier.js";
import { inferExplicitCategoryIds } from "../src/catalog/category-rules.js";
import { normalizeCatalogProduct } from "../src/catalog/product-normalizer.js";
import { retainedCategoryEvidence } from "../src/catalog/retained-category-evidence.js";
import { inferFacetFacts } from "../src/catalog/product-facets.js";
import { HIFIDO_CATEGORY_MAPPING, parseHifidoListing } from "../src/crawler/shops/hifido.js";
import { parsedProduct } from "./helpers/fixtures.js";

test("recording media and noise accessories participate in canonical parent filters", () => {
  for (const [id, parent] of [
    ["REC.MEDIA", "REC"],
    ["ACC.GROUND_NOISE", "ACC"],
  ]) {
    assert.equal(getCategory(id)?.classifiable, true);
    assert.deepEqual(categoryClosureIds(id), [id, parent]);
    assert.ok(categoryFilterIds(parent).includes(id));
  }
});

test("recording tape and reels are separate from decks, cases and cleaning supplies", () => {
  for (const title of [
    "10号メタルリール",
    "7号プラスチックリール",
    "空リール",
    "SONY オープンリールテープ SLH-550",
    "TDK カセットテープ",
    "Scotch blank tape",
  ]) {
    assert.deepEqual(inferExplicitCategoryIds(title), ["REC.MEDIA"], title);
  }
  for (const title of [
    "TEAC オープンリールデッキ",
    "Nakamichi cassette tape deck",
    "オープンリールテープ対応 レコーダー",
    "カセットデッキ テープ付き",
  ]) {
    assert.deepEqual(inferExplicitCategoryIds(title), ["ANA.TAPE"], title);
  }
  for (const title of [
    "カセットテープ用ケース",
    "カセットテープ クリーニング",
    "釣り用リール",
    "Example SLH-550",
    "オープンリールテープ用交換部品",
  ]) {
    assert.notEqual(inferExplicitCategoryIds(title)[0], "REC.MEDIA", title);
  }
});

test("Hifido preserves the complete tape-media genre before the shorter deck prefix", () => {
  const [listing] = parseHifidoListing(`<div class="list-item">
    <h3><a href="/26-32956-18597-00.html?LNG=J" id="type-26-32956-18597-00">1500-550</a></h3>
    <div id="maker-26-32956-18597-00">メーカー:Scotch</div>
    <div id="price-26-32956-18597-00">売価:1,500円(税込)</div>
    <div id="genre-26-32956-18597-00">オープンリールテープ</div>
    </div>`);
  assert.equal(listing.rawCategory, "オープンリールテープ");
  assert.equal(
    normalizeCatalogProduct(listing, { categoryMapping: HIFIDO_CATEGORY_MAPPING })
      .primaryCategoryId,
    "REC.MEDIA",
  );
});

test("reviewed noise products classify without assigning a catalog identity", () => {
  for (const [title, manufacturer] of [
    ["Crystal E", "KOJO"],
    ["KOJO コージョー Crystal EpHA", ""],
    ["KOJO Crystal EpY x 2", ""],
    ["Force bar EP / KOJO", ""],
    ["GC3 / CAD 別売りケーブル付き", ""],
    ["THE CHORD COMPANY GroundARAY（LAN端子用/1個）", ""],
    ["NCF CLEAR LINE", "FURUTECH"],
    ["SilentPower サイレントパワー iSilencer Max [SLP-ISILENCER-MAX]", ""],
    ["TELOS テロス Macro G-USB", ""],
    ["AKIKO Audio アキコ オーディオ Triple AC Enhancer", ""],
    ["オーディオみじんこ SILVER BULLET 3.5", ""],
    ["IsoTek アイソテック EVO3 ISOPLUG", ""],
  ]) {
    const product = normalizeCatalogProduct(
      parsedProduct({ title, manufacturer, rawManufacturer: manufacturer }),
    );
    assert.equal(product.primaryCategoryId, "ACC.GROUND_NOISE", title);
    assert.ok(
      product.facetFacts.some((fact) => fact.facetId === "noise_accessory_type"),
      title,
    );
    assert.ok(
      product.categoryEvidence.some(
        (item) =>
          item.source === "reviewed_product_type" &&
          item.ruleId &&
          item.value?.startsWith("https://"),
      ),
      title,
    );
  }
  assert.deepEqual(inferExplicitCategoryIds("Entreq Silver Tellus 仮想アース"), [
    "ACC.GROUND_NOISE",
  ]);
  assert.deepEqual(inferExplicitCategoryIds("USBノイズ除去フィルター"), ["ACC.GROUND_NOISE"]);
});

test("reviewed Fujiya placeholder products receive their confirmed product type", () => {
  for (const [title, model, category] of [
    [
      "その他 そのた ESSENCE AUDIO 4.4mm to 4.4mm mini-mini Cable",
      "ESSENCE AUDIO 4.4mm to 4.4mm mini-mini Cable",
      "CAB.ANALOG",
    ],
    ["その他 そのた QuillAcoustics Satin", "QuillAcoustics Satin", "PER.EARPHONE"],
    ["その他 そのた G4 Audio Dracula", "G4 Audio Dracula", "PER.EARPHONE"],
    ["その他 そのた Mother Audio ME5", "Mother Audio ME5", "PER.EARPHONE"],
    ["Mother Audio ME5 with ear hooks", "Mother Audio ME5", "PER.EARPHONE"],
    ["Mother Audio ME5 イヤーフック付き", "Mother Audio ME5", "PER.EARPHONE"],
  ] as const) {
    const product = normalizeCatalogProduct(
      parsedProduct({
        title,
        manufacturer: "その他",
        rawManufacturer: "その他",
        model,
        rawModel: model,
      }),
      {},
      { shopKey: "fujiya-avic" },
    );
    assert.equal(product.primaryCategoryId, category, title);
    assert.ok(
      product.categoryEvidence.some(
        (item) => item.source === "reviewed_product_type" && item.value?.startsWith("https://"),
      ),
      title,
    );
  }

  for (const title of [
    "Mother Audio ME5 Cable",
    "Mother Audio ME5 adapter",
    "Mother Audio ME5 ear hooks",
    "Mother Audio ME5 イヤーフック",
    "Quill Acoustics Satin 専用ケース",
    "G4 Audio Dracula replacement cord",
  ]) {
    assert.notEqual(
      normalizeCatalogProduct(parsedProduct({ title })).primaryCategoryId,
      "PER.EARPHONE",
      title,
    );
  }
});

test("model hints do not consume compatibility, replacement parts or unknown revisions", () => {
  for (const title of [
    "KOJO Crystal EpHA用交換プラグ",
    "KOJO Crystal E 専用ケース",
    "KOJO Crystal E アースケーブル",
    "KOJO Ep-typeHA",
    "KOJO Crystal EpXYZ",
    "Other Brand Crystal E",
    "CAD GC10",
    "SilentPower LAN iSilencer+",
    "FURUTECH NCF Booster",
    "CHORD Electronics GroundARAY",
    "TELOS Macro G-USB対応 アダプター",
  ]) {
    assert.notEqual(
      normalizeCatalogProduct(parsedProduct({ title, manufacturer: "", rawManufacturer: "" }))
        .primaryCategoryId,
      "ACC.GROUND_NOISE",
      title,
    );
  }
  for (const [title, expected] of [
    ["仮想アース用 RCAアナログケーブル", "CAB.ANALOG"],
    ["USBノイズ除去 USB isolator", "SIG.ISOLATOR"],
    ["ノイズ対策 電源タップ", "PWR.DISTRIBUTION"],
    ["ノイズ対策 power conditioner", "PWR.CONDITIONER"],
    ["KOJO Crystal E用交換部品", "ACC.PART"],
    ["仮想アース用変換プラグ", "CAB.ADAPTER"],
    ["ノイズキャンセリングヘッドホン", "PER.HEADPHONE"],
    ["仮想アース対応 ヘッドホンアンプ", "AMP.HEADPHONE"],
  ])
    assert.equal(
      normalizeCatalogProduct(parsedProduct({ title, manufacturer: "", rawManufacturer: "" }))
        .primaryCategoryId,
      expected,
      title,
    );
});

test("replay reinterprets old seller vocabulary without raising authority or losing external evidence", () => {
  const raw = { title: "1500-550", rawCategory: "オープンリールテープ", hintedCategory: "未分類" };
  const stored = {
    categoryClassification: {
      version: 15,
      evidence: [
        {
          source: "seller_category",
          strength: "supporting",
          categoryIds: ["ANA.TAPE"],
          value: raw.rawCategory,
        },
      ],
    },
  };
  const replayed = retainedCategoryEvidence(raw, stored);
  assert.equal(replayed[0].strength, "supporting");
  assert.equal(classifyCategoryEvidence(replayed).primaryCategoryId, "REC.MEDIA");
  const manual = {
    source: "manual_override",
    strength: "verified",
    categoryIds: ["ACC.CASE"],
    value: "confirmed storage case",
  };
  const detail = {
    source: "detail_metadata",
    strength: "strong",
    categoryIds: ["REC.MEDIA"],
    value: "recording tape",
  };
  const preserved = retainedCategoryEvidence(raw, {
    categoryClassification: {
      evidence: [...stored.categoryClassification.evidence, manual, detail],
    },
  });
  assert.ok(preserved.includes(manual));
  assert.ok(preserved.includes(detail));
  assert.equal(classifyCategoryEvidence(preserved).primaryCategoryId, "ACC.CASE");
  const opaque = {
    source: "seller_category",
    strength: "supporting",
    categoryIds: ["AMP.PRE"],
    value: "shop-bucket-27",
  };
  assert.deepEqual(
    retainedCategoryEvidence(raw, { categoryClassification: { evidence: [opaque] } })[0],
    opaque,
  );
});

test("media and accessory facets describe only explicit properties", () => {
  assert.ok(
    inferFacetFacts("Crystal E", { manufacturer: "KOJO" }).some(
      (fact) => fact.facetId === "noise_accessory_type" && fact.value === "grounding",
    ),
  );
  for (const [title, manufacturer] of [
    ["Crystal E", "Other Brand"],
    ["Crystal E用交換部品", "KOJO"],
  ])
    assert.equal(
      inferFacetFacts(title, { manufacturer }).some(
        (fact) => fact.facetId === "noise_accessory_type",
      ),
      false,
    );
  const pairs = (title: string) =>
    inferFacetFacts(title).map((fact) => `${fact.facetId}:${fact.value}`);
  assert.ok(pairs("10号メタルリール").includes("reel_size:size_10"));
  assert.ok(pairs("7号プラスチックリール").includes("recording_medium:open_reel"));
  assert.ok(pairs("カセットテープ").includes("recording_medium:cassette"));
  assert.equal(
    pairs("7号 / 10号 空リールセット").some((value) => value.startsWith("reel_size:")),
    false,
  );
  assert.ok(pairs("KOJO Crystal EpHA").includes("noise_accessory_type:grounding"));
  assert.ok(pairs("SilentPower iSilencer Max").includes("noise_accessory_type:usb_filter"));
  assert.equal(
    pairs("KOJO Crystal E用 RCAケーブル").some((value) =>
      value.startsWith("noise_accessory_type:"),
    ),
    false,
  );
});
